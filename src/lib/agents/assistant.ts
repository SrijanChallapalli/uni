// The personal agent's command interpreter: turns "do this or that" into one intent.
// It only classifies. What each intent is allowed to do is decided by deterministic services.
import { z } from "zod";
import { MODE_MAX_SIZE, SIZE_RANK, type Mode, type PackageSize } from "../locations";
import { campusAt } from "../time";
import { structuredCall, untrusted } from "./llm";
import { parseClock, STORE_WORDS, TIME, ZONE_WORDS } from "./requester";

export type Intent =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "request"; text: string }
  | { kind: "post_trip"; text: string }
  | { kind: "confirm" }
  | { kind: "decline" }
  | { kind: "hire"; name: string }
  | { kind: "rematch" }
  | { kind: "picked_up" }
  | { kind: "handoff_code"; code: string }
  | { kind: "release" }
  | { kind: "review"; rating: number | null; comment: string | null }
  | { kind: "dispute"; reason: string }
  | { kind: "cancel" }
  | { kind: "auto_accept"; on: boolean }
  | { kind: "unknown" };

export type PendingKind = "request" | "trip" | "review" | undefined;

const CONFIRM = /^(yes|yep|yeah|ya|y|ok(ay)?|sure|do it|go( ahead)?|confirm|approve|accept( it)?|sounds good|book it|lock it in|hire( them| her| him)?|let'?s do it|deal)\b[\s.!]*$/i;
const DECLINE = /^(no|nope|nah|pass|skip|not this one|decline)\b[\s.!]*$/i;

export function classifyRules(raw: string, pending: PendingKind): Intent {
  const text = raw.trim().slice(0, 1000);
  const t = text.toLowerCase();
  if (!t) return { kind: "unknown" };
  if (/^(help|\?|what can you do|commands?)\b/.test(t)) return { kind: "help" };
  if (CONFIRM.test(t)) return { kind: "confirm" };
  if (DECLINE.test(t)) return { kind: "decline" };
  if (/^(status|update|what'?s (up|happening|next|going on)|where('?s| is) my|any (news|update))/.test(t)) return { kind: "status" };

  const rating = /\b([1-5])\s*(?:stars?|\/\s*5|★)/.exec(t) ?? (pending === "review" ? /^\s*([1-5])\b/.exec(t) : null);
  if (rating || /^(rate|review)\b/.test(t)) {
    const comment = text.replace(/\b[1-5]\s*(?:stars?|\/\s*5|★)|^(rate|review)\b|^\s*[1-5]\b/gi, "").replace(/^[\s,.:;!-]+|[\s,.:;!-]+$/g, "");
    return { kind: "review", rating: rating ? Number(rating[1]) : null, comment: comment.length >= 2 ? comment.slice(0, 500) : null };
  }

  const code = /\b(\d{6})\b/.exec(t) ?? /\b(?:code|pin)\D{0,12}(\d{4,8})\b/.exec(t);
  if (code && !/\$\s*\d|\b(?:at|by|before|after)\s+\d/.test(t.replace(code[1], ""))) return { kind: "handoff_code", code: code[1] };

  if (/\b(picked (it |the order |the bag |the package )?up|got (the|their|her|his) (order|package|bag)|have (the|their) (order|package|bag))\b/.test(t)) return { kind: "picked_up" };
  if (/\b(dispute|missing|damaged|broken|wrong (item|order|bag)|never (came|arrived|showed)|something'?s (wrong|missing|off))\b/.test(t)) return { kind: "dispute", reason: text };
  if (/^(got it|received( it)?|it (came|arrived)|all good|looks good|release|pay (her|him|them)|thanks,? got it)\b/.test(t)) return { kind: "release" };
  if (/\b(cancel|call (it|this) off|never ?mind)\b/.test(t)) return { kind: "cancel" };
  if (/\b(ask me first|don'?t auto|stop auto|turn off auto|manual approval)/.test(t)) return { kind: "auto_accept", on: false };
  if (/\b(auto[- ]?accept|take (any|all) (jobs|errands)|accept jobs automatically)\b/.test(t) && !/\b(going|heading|driving|biking|leaving)\b/.test(t)) return { kind: "auto_accept", on: true };
  if (/\b((search|look|find|try|ask) (again|around)|anyone else|more (workers|people|options)|find (me )?(someone|somebody|a worker|workers|a driver|matches|a match))\b/.test(t)) return { kind: "rematch" };
  const hire = /^(?:hire|go with|pick|choose|use|book) ([a-z][a-z'-]{1,30})\b/.exec(t);
  if (hire && !["it", "them", "her", "him", "up", "the", "my", "a"].includes(hire[1])) return { kind: "hire", name: hire[1] };

  const store = STORE_WORDS.some(([r]) => r.test(t));
  if (/\b(i'?m|i am|i'll be|im)\s+(going|heading|driving|biking|walking|taking the bus|busing|running)\b|\bleaving (at|for)\b|\bmy (trip|run)\b/.test(t)) return { kind: "post_trip", text };
  if (/\b(grab|pick ?up|get|bring|deliver|fetch|need)\b/.test(t) && (store || /\border\b/.test(t))) return { kind: "request", text };
  if (pending === "request") return { kind: "request", text };
  if (pending === "trip") return { kind: "post_trip", text };
  if (store) return { kind: "request", text };
  return { kind: "unknown" };
}

const llmIntent = z.object({
  intent: z.enum(["help", "status", "request", "post_trip", "confirm", "decline", "hire", "rematch", "picked_up", "handoff_code", "release", "review", "dispute", "cancel", "auto_accept_on", "auto_accept_off", "unknown"]),
  worker_name: z.string().max(40).nullable(),
  code: z.string().regex(/^\d{4,8}$/).nullable(),
  rating: z.number().int().min(1).max(5).nullable(),
  comment: z.string().max(500).nullable(),
});

/** LLM classification when configured (validated), rules otherwise. Neither can act; services decide. */
export async function classify(text: string, pending: PendingKind): Promise<Intent & { source: "llm" | "rules" }> {
  const rules = classifyRules(text, pending);
  // Short, unambiguous confirmations never go to the LLM.
  if (rules.kind === "confirm" || rules.kind === "decline" || rules.kind === "handoff_code") return { ...rules, source: "rules" };
  const out = await structuredCall({
    system:
      "You route a Purdue student's message to their personal errand agent. Pick exactly one intent. " +
      "request = they want something picked up and delivered to them. post_trip = they are going to a store themselves and could carry an errand. " +
      "confirm = yes to the agent's last suggestion. hire = choose a specific worker by name. picked_up = worker has the order. " +
      "handoff_code = worker typed the requester's code. release = requester got the order and is happy. dispute = something went wrong after pickup. " +
      `The agent previously asked a follow-up about: ${pending ?? "nothing"}.`,
    user: untrusted(text.slice(0, 1000)),
    toolName: "route_message",
    toolDescription: "Classify the message into one intent with any extracted fields.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string", enum: llmIntent.shape.intent.options },
        worker_name: { type: ["string", "null"] }, code: { type: ["string", "null"] },
        rating: { type: ["integer", "null"] }, comment: { type: ["string", "null"] },
      },
      required: ["intent", "worker_name", "code", "rating", "comment"],
    },
    validator: llmIntent,
  });
  if (!out) return { ...rules, source: "rules" };
  const k = out.intent;
  const intent: Intent =
    k === "request" || k === "post_trip" ? { kind: k, text }
    : k === "hire" ? (out.worker_name ? { kind: "hire", name: out.worker_name.toLowerCase() } : rules)
    : k === "handoff_code" ? (out.code ? { kind: "handoff_code", code: out.code } : rules)
    : k === "review" ? { kind: "review", rating: out.rating, comment: out.comment }
    : k === "dispute" ? { kind: "dispute", reason: text }
    : k === "auto_accept_on" ? { kind: "auto_accept", on: true }
    : k === "auto_accept_off" ? { kind: "auto_accept", on: false }
    : { kind: k };
  return { ...intent, source: "llm" };
}

// ------------------------------------------------------------------ trip commands
export interface TripDraft {
  store_id: string | null;
  origin_zone: string;
  return_zone: string;
  depart_at: Date | null;
  return_by: Date | null;
  transport: Mode;
  capacity: PackageSize;
  auto_accept: boolean;
}

/** "I'm driving to Target at 4:30 from Harrison, back by 6:30" → trip fields (rules only, deterministic). */
export function parseTripCommand(text: string, now: Date, defaults: { homeZone: string; transport: Mode; capacity: PackageSize }): { draft: TripDraft; question: string | null } {
  const t = text.toLowerCase();
  const day = /tomorrow/.test(t) ? 1 : 0;
  const store = STORE_WORDS.find(([r]) => r.test(t))?.[1] ?? null;
  // The zone mentioned first right after the keyword ("from Cary, back to Windsor" → Cary).
  const zoneIn = (s: string | undefined) => {
    if (!s) return null;
    let best: { i: number; id: string } | null = null;
    for (const [r, id] of ZONE_WORDS) {
      const m = r.exec(s);
      if (m && (!best || m.index < best.i)) best = { i: m.index, id };
    }
    return best?.id ?? null;
  };
  const origin = zoneIn(/\bfrom\s+(.{0,30})/.exec(t)?.[1]) ?? defaults.homeZone;
  const ret = zoneIn(/\b(?:back to|return(?:ing)? to|then to)\s+(.{0,30})/.exec(t)?.[1]) ?? (/\bhome\b/.test(t) ? defaults.homeZone : origin);

  const at = (m: RegExpExecArray | null) => {
    if (!m) return null;
    const c = parseClock(m[1], m[2], m[3]);
    return c ? campusAt(c[0], c[1], day, now) : null;
  };
  const returnBy = at(new RegExp(String.raw`\b(?:back|return(?:ing)?|home)\b[^0-9]{0,20}?(?:by|at|around|before)\s+${TIME}`, "i").exec(t));
  const departRe = new RegExp(String.raw`\b(?:at|leaving|leave|around|departing|after)\s+${TIME}`, "gi");
  let depart: Date | null = null;
  for (let m = departRe.exec(t); m; m = departRe.exec(t)) {
    const before = t.slice(Math.max(0, m.index - 25), m.index);
    if (/\b(back|return|returning|home)\b[^.]*$/.test(before)) continue; // that one is the return time
    depart = at(m);
    if (depart) break;
  }
  const transport: Mode = /\b(driv|car)/.test(t) ? "car" : /\bbik/.test(t) ? "bike" : /\bbus\b/.test(t) ? "bus" : /\bwalk/.test(t) ? "walk" : defaults.transport;
  const capacity: PackageSize = SIZE_RANK[defaults.capacity] > SIZE_RANK[MODE_MAX_SIZE[transport]] ? MODE_MAX_SIZE[transport] : defaults.capacity;
  const draft: TripDraft = {
    store_id: store, origin_zone: origin, return_zone: ret, depart_at: depart,
    return_by: returnBy ?? (depart ? new Date(depart.getTime() + 2 * 3600_000) : null),
    transport, capacity, auto_accept: !/\bask me\b|\bdon'?t auto\b|\bmanual\b/.test(t),
  };
  const question = !store ? "Which store are you going to?" : !depart ? "What time are you leaving?" : null;
  return { draft, question };
}
