// Requester agent: structures a natural-language request, checks budget/deadline,
// compares worker offers, and explains its recommendation. It cannot commit the user.
import { z } from "zod";
import { PLACES, STORE_IDS, STORES, ZONE_IDS, ZONES } from "../locations";
import { dollarsToUnits, formatUsd, unitsToDollarString } from "../money";
import { campusAt, toCampusLocal } from "../time";
import { structuredCall, untrusted } from "./llm";

const LOCAL_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export interface RequestDraft {
  store_id: string | null;
  delivery_zone: string | null;
  pickup_window_start: string | null; // campus local "YYYY-MM-DDTHH:mm"
  pickup_window_end: string | null;
  delivery_deadline: string | null;
  package_size: "small" | "medium" | "large" | null;
  prepaid: boolean | null;
  offered_fee: string | null; // dollars "5.00"
  max_fee: string | null;
  order_reference: string | null;
  instructions: string | null;
}

export interface ParseResult {
  draft: RequestDraft;
  missing: (keyof RequestDraft)[];
  question: string | null;
  notes: string[];
  warnings: string[];
  source: "llm" | "rules";
}

export const REQUIRED_FIELDS: (keyof RequestDraft)[] = [
  "store_id", "delivery_zone", "pickup_window_start", "pickup_window_end", "delivery_deadline", "package_size", "prepaid", "max_fee",
];

const FIELD_QUESTION: Record<string, string> = {
  store_id: "Which store is the order at?",
  delivery_zone: "Where on campus should it be delivered?",
  pickup_window_start: "When will the order be ready for pickup?",
  pickup_window_end: "Until when can it be picked up?",
  delivery_deadline: "What's the latest it can arrive?",
  package_size: "How big is the package — backpack-size, one bag, or bigger?",
  prepaid: "Is the order already paid for? Workers never front purchase costs.",
  max_fee: "What's the most you'd pay for delivery?",
};

const INJECTION_PATTERNS = [
  /ignore (all|any|previous|prior|the above)/i, /system prompt/i, /you are now/i, /approve (this|the|my)/i,
  /(send|transfer|release) (the )?(money|funds|payment|usdc)/i, /set (the )?fee/i, /developer mode/i,
];

export function detectInjection(text: string): string[] {
  return INJECTION_PATTERNS.some((r) => r.test(text))
    ? ["This description contains instruction-like text. Agents treat it only as errand details; it cannot change fees, approvals or payments."]
    : [];
}

// ------------------------------------------------------------------ rules parser (fallback, deterministic)
export const STORE_WORDS: [RegExp, string][] = [[/target/i, "target_wl"], [/walmart/i, "walmart_laf"], [/\bcvs\b/i, "cvs_state"], [/pay ?less/i, "payless_wl"]];
export const ZONE_WORDS: [RegExp, string][] = [
  [/hillenbrand|meredith/i, "hillenbrand"], [/earhart|windsor/i, "earhart_windsor"], [/cary|tarkington/i, "cary_quad"],
  [/harrison|hawkins/i, "harrison"], [/\bpmu\b|memorial union|the union/i, "pmu"], [/chauncey/i, "chauncey"], [/third st|aspire/i, "third_st"],
];

export function parseClock(h: string, m: string | undefined, mer: string | undefined): [number, number] | null {
  let hh = Number(h);
  const mm = Number(m ?? 0);
  if (hh > 23 || mm > 59) return null;
  const mr = mer?.replace(/\./g, "").toLowerCase();
  if (mr === "pm" && hh < 12) hh += 12;
  if (mr === "am" && hh === 12) hh = 0;
  if (!mr && hh >= 1 && hh <= 9) hh += 12; // "by 7" on campus almost always means evening
  return [hh, mm];
}

export const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?`;

export function rulesParse(text: string, now: Date, defaults: { maxFeeUnits: number }): ParseResult {
  const d: RequestDraft = {
    store_id: null, delivery_zone: null, pickup_window_start: null, pickup_window_end: null, delivery_deadline: null,
    package_size: null, prepaid: null, offered_fee: null, max_fee: null, order_reference: null, instructions: null,
  };
  const notes: string[] = [];
  const day = /tomorrow/i.test(text) ? 1 : 0;
  const at = (c: [number, number]) => toCampusLocal(campusAt(c[0], c[1], day, now));

  d.store_id = STORE_WORDS.find(([r]) => r.test(text))?.[1] ?? null;
  // Delivery zone: prefer a zone mentioned after "to"/"at"/"near"; otherwise any zone mention.
  const deliveryPart = /(?:deliver(?:ed)?|bring|drop(?: it)? off|to|near)\s+(.{0,60})/i.exec(text)?.[1] ?? text;
  d.delivery_zone = ZONE_WORDS.find(([r]) => r.test(deliveryPart))?.[1] ?? ZONE_WORDS.find(([r]) => r.test(text))?.[1] ?? null;

  const deadline = new RegExp(String.raw`(?:before|by|no later than)\s+${TIME}`, "i").exec(text);
  if (deadline) {
    const c = parseClock(deadline[1], deadline[2], deadline[3]);
    if (c) d.delivery_deadline = at(c);
  }
  const between = new RegExp(String.raw`(?:between|from)\s+${TIME}\s*(?:and|to|-|–)\s*${TIME}`, "i").exec(text);
  const ready = new RegExp(String.raw`(?:ready|pick(?:ed)?\s?up|available)\s+(?:at|after|from|by)?\s*${TIME}`, "i").exec(text);
  if (between) {
    const a = parseClock(between[1], between[2], between[3]);
    const b = parseClock(between[4], between[5], between[6]);
    if (a && b) { d.pickup_window_start = at(a); d.pickup_window_end = at(b); }
  } else if (ready) {
    const a = parseClock(ready[1], ready[2], ready[3]);
    if (a) {
      d.pickup_window_start = at(a);
      if (d.delivery_deadline) {
        const end = new Date(campusAt(a[0], a[1], day, now).getTime());
        const dl = campusAt(Number(d.delivery_deadline.slice(11, 13)), Number(d.delivery_deadline.slice(14, 16)), day, now);
        const latest = new Date(Math.max(end.getTime() + 30 * 60000, dl.getTime() - 20 * 60000));
        d.pickup_window_end = toCampusLocal(latest);
        notes.push("Pickup window end assumed 20 min before your deadline — edit if needed.");
      }
    }
  }

  if (/\b(small|backpack|envelope|tiny)\b/i.test(text)) d.package_size = "small";
  else if (/\b(medium|bag|box|shoebox)\b/i.test(text)) d.package_size = "medium";
  else if (/\b(large|big|heavy|bulky)\b/i.test(text)) d.package_size = "large";

  if (/not (yet )?paid|pay (at|in) (the )?store|cash on/i.test(text)) d.prepaid = false;
  else if (/pre-?paid|already paid|paid for|paid online|order pickup|drive ?up/i.test(text)) d.prepaid = true;

  const max = /(?:up to|max(?:imum)?|at most|no more than)\s*\$?(\d{1,3}(?:\.\d{1,2})?)/i.exec(text);
  const any = /\$(\d{1,3}(?:\.\d{1,2})?)/.exec(text);
  if (max) d.max_fee = Number(max[1]).toFixed(2);
  if (any && (!max || any[1] !== max[1])) d.offered_fee = Number(any[1]).toFixed(2);
  if (!d.max_fee && d.offered_fee) d.max_fee = d.offered_fee;
  if (!d.max_fee && defaults.maxFeeUnits > 0) {
    d.max_fee = unitsToDollarString(defaults.maxFeeUnits);
    notes.push(`Max fee taken from your agent preferences (${formatUsd(defaults.maxFeeUnits)}).`);
  }

  const ord = /order\s*(?:#|number|no\.?)?\s*([A-Z0-9][A-Z0-9-]{3,19})/i.exec(text);
  if (ord && /\d/.test(ord[1])) d.order_reference = ord[1].toUpperCase();
  const instr = /(?:instructions?|note|ask for|name on (?:the )?order)[:\s]+(.{3,200})/i.exec(text);
  if (instr) d.instructions = instr[0].trim().slice(0, 500);

  return finalize(d, notes, detectInjection(text), "rules");
}

function finalize(d: RequestDraft, notes: string[], warnings: string[], source: "llm" | "rules"): ParseResult {
  if (d.max_fee && !d.offered_fee) {
    // Requester agent opens a little below the cap to leave room for one counteroffer.
    const maxU = dollarsToUnits(d.max_fee);
    const open = Math.max(1_000_000, Math.floor((maxU * 0.75) / 10_000) * 10_000);
    d.offered_fee = unitsToDollarString(Math.min(open, maxU));
    notes.push(`Opening offer set to ${formatUsd(Math.min(open, maxU))}, below your ${formatUsd(maxU)} max, leaving room for one counteroffer.`);
  }
  const missing = REQUIRED_FIELDS.filter((f) => d[f] === null || d[f] === "");
  const question = missing.length ? missing.map((f) => FIELD_QUESTION[f]).slice(0, 2).join(" ") : null;
  if (d.prepaid === false) warnings.push("Only prepaid orders are supported — workers never front purchase costs.");
  return { draft: d, missing, question, notes, warnings, source };
}

// ------------------------------------------------------------------ LLM parser
const llmDraft = z.object({
  store_id: z.enum(STORE_IDS).nullable(),
  delivery_zone: z.enum(ZONE_IDS).nullable(),
  pickup_window_start: z.string().regex(LOCAL_DT).nullable(),
  pickup_window_end: z.string().regex(LOCAL_DT).nullable(),
  delivery_deadline: z.string().regex(LOCAL_DT).nullable(),
  package_size: z.enum(["small", "medium", "large"]).nullable(),
  prepaid: z.boolean().nullable(),
  offered_fee_dollars: z.number().min(0).max(100).nullable(),
  max_fee_dollars: z.number().min(0).max(100).nullable(),
  order_reference: z.string().max(80).nullable(),
  instructions: z.string().max(500).nullable(),
  clarifying_question: z.string().max(240).nullable(),
});

const nullable = (type: string, extra: Record<string, unknown> = {}) => ({ anyOf: [{ type, ...extra }, { type: "null" }] });

export async function parseRequest(text: string, now: Date, defaults: { maxFeeUnits: number }): Promise<ParseResult> {
  const clipped = text.slice(0, 1000);
  const rules = rulesParse(clipped, now, defaults);
  const out = await structuredCall({
    system:
      "You are a requester's errand agent for Purdue students. Convert the request into fields. Use only the listed store and zone ids; " +
      "use null when the user did not say something (do not guess times or fees). Times are campus-local in YYYY-MM-DDTHH:mm. " +
      `Current campus time: ${toCampusLocal(now)}.\nStores: ${STORES.map((s) => `${s.id}=${s.name}`).join("; ")}\n` +
      `Delivery zones: ${ZONES.map((z) => `${z.id}=${z.name}`).join("; ")}`,
    user: `Errand request:\n${untrusted(clipped)}`,
    toolName: "structure_request",
    toolDescription: "Return the structured errand request fields.",
    inputSchema: {
      type: "object",
      properties: {
        store_id: nullable("string", { enum: STORE_IDS }),
        delivery_zone: nullable("string", { enum: ZONE_IDS }),
        pickup_window_start: nullable("string"), pickup_window_end: nullable("string"), delivery_deadline: nullable("string"),
        package_size: nullable("string", { enum: ["small", "medium", "large"] }),
        prepaid: nullable("boolean"),
        offered_fee_dollars: nullable("number"), max_fee_dollars: nullable("number"),
        order_reference: nullable("string"), instructions: nullable("string"), clarifying_question: nullable("string"),
      },
      required: Object.keys(llmDraft.shape),
    },
    validator: llmDraft,
  });
  if (!out) return rules;
  const money = (v: number | null) => (v === null ? null : v.toFixed(2));
  const draft: RequestDraft = {
    store_id: out.store_id, delivery_zone: out.delivery_zone,
    pickup_window_start: out.pickup_window_start, pickup_window_end: out.pickup_window_end, delivery_deadline: out.delivery_deadline,
    package_size: out.package_size, prepaid: out.prepaid,
    offered_fee: money(out.offered_fee_dollars), max_fee: money(out.max_fee_dollars) ?? rules.draft.max_fee,
    order_reference: out.order_reference, instructions: out.instructions,
  };
  const notes = draft.max_fee === rules.draft.max_fee && out.max_fee_dollars === null ? rules.notes.filter((n) => n.startsWith("Max fee")) : [];
  const res = finalize(draft, notes, detectInjection(clipped), "llm");
  if (out.clarifying_question && res.missing.length) res.question = out.clarifying_question;
  return res;
}

// ------------------------------------------------------------------ recommendation
export interface CandidateForRecommendation {
  offerId: string;
  workerName: string;
  decision: "accept" | "counter";
  feeUnits: number;
  /** Worker-agent turns in the negotiation (1 = accepted the opening offer). */
  rounds?: number;
  withinBudget: boolean;
  score: number;
  extraLow: number;
  extraHigh: number;
  slackMin: number;
  reputationNote: string;
}

export interface Recommendation {
  offerId: string | null;
  summary: string;
  tradeoffs: string[];
  source: "llm" | "rules";
}

export function rulesRecommend(cands: CandidateForRecommendation[], maxFeeUnits: number): Recommendation {
  const ok = cands.filter((c) => c.withinBudget).sort((a, b) => b.score - a.score);
  if (!ok.length) {
    return {
      offerId: null, source: "rules", tradeoffs: [],
      summary: cands.length
        ? `No offer fits your ${formatUsd(maxFeeUnits)} maximum. You can raise your max fee or wait for more trips.`
        : "No one with a matching trip can make it in time yet. Try widening your pickup window or deadline.",
    };
  }
  const best = ok[0];
  const tradeoffs = ok.slice(1, 3).map((c) =>
    `${c.workerName}: ${formatUsd(c.feeUnits)}, ${c.extraLow}–${c.extraHigh} extra min for them, ${c.slackMin} min slack (${c.reputationNote}).`);
  return {
    offerId: best.offerId, source: "rules", tradeoffs,
    summary: `${best.workerName} is the best fit: ${best.decision !== "accept" ? "countered" : (best.rounds ?? 1) > 1 ? `agreed after ${best.rounds} rounds of negotiation` : "accepts your offer"} at ${formatUsd(best.feeUnits)}, ` +
      `adds only ${best.extraLow}–${best.extraHigh} min to a trip they're already taking, and has ${best.slackMin} min of slack before your deadline.`,
  };
}

const recSchema = z.object({ offer_id: z.string().nullable(), summary: z.string().min(1).max(400), tradeoffs: z.array(z.string().max(240)).max(3) });

export async function recommend(cands: CandidateForRecommendation[], maxFeeUnits: number): Promise<Recommendation> {
  const rules = rulesRecommend(cands, maxFeeUnits);
  if (!cands.some((c) => c.withinBudget)) return rules;
  const out = await structuredCall({
    system:
      "You are the requester's agent. Recommend one offer from the candidates. Only offers with withinBudget=true may be recommended. " +
      "Prefer low extra effort for the worker, comfortable timing slack, lower fee, and reliable reputation. Be concise and concrete.",
    user: JSON.stringify(cands.map((c) => ({ ...c, fee: formatUsd(c.feeUnits) }))),
    toolName: "recommend_offer",
    toolDescription: "Recommend one offer and summarize tradeoffs.",
    inputSchema: {
      type: "object",
      properties: { offer_id: { type: ["string", "null"] }, summary: { type: "string" }, tradeoffs: { type: "array", items: { type: "string" } } },
      required: ["offer_id", "summary", "tradeoffs"],
    },
    validator: recSchema,
  });
  if (!out || !out.offer_id || !cands.some((c) => c.offerId === out.offer_id && c.withinBudget)) return rules;
  return { offerId: out.offer_id, summary: out.summary, tradeoffs: out.tradeoffs, source: "llm" };
}

export const placeLabel = (id: string | null) => (id ? PLACES[id]?.name ?? id : "—");
