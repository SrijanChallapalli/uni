// Agent-to-agent negotiation. The requester's agent and one worker's agent exchange offers for a
// few rounds. Each side only sees its own limits:
//   - the worker agent never sees the requester's max fee (it only sees the current offer);
//   - the requester agent never sees the worker's minimum (it only sees counters).
// The requester side is deterministic; the worker side may be an LLM but is validated every turn.
import { formatUsd, UNITS_PER_CENT } from "../money";
import type { WorkerDecision } from "./worker";

export const MAX_WORKER_TURNS = 3;
const SMALL_GAP = 100 * UNITS_PER_CENT; // $1.00: close enough to just accept the ask

export interface Turn {
  round: number;
  from: "requester_agent" | "worker_agent";
  kind: "offer" | "accept" | "counter" | "reject" | "walk_away";
  feeUnits: number;
  text: string;
  source: "llm" | "rules";
}

export interface NegotiationResult {
  outcome: "deal" | "over_budget" | "no_deal";
  feeUnits: number;
  summary: string;
  transcript: Turn[];
  source: "llm" | "rules";
}

export type RequesterMove = { kind: "accept"; feeUnits: number } | { kind: "counter"; feeUnits: number } | { kind: "walk_away" };

const toCent = (u: number) => Math.round(u / UNITS_PER_CENT) * UNITS_PER_CENT;

/** Deterministic requester-agent response to a worker's counter (ask) or rejection (ask = null). */
export function requesterRespond(a: { offer: number; ask: number | null; max: number; lastRound: boolean }): RequesterMove {
  const { offer, ask, max, lastRound } = a;
  if (ask !== null) {
    if (ask <= offer) return { kind: "accept", feeUnits: offer };
    if (ask <= max) {
      if (lastRound || ask - offer <= SMALL_GAP) return { kind: "accept", feeUnits: ask };
      const mid = toCent((offer + ask) / 2);
      return mid > offer && mid < ask ? { kind: "counter", feeUnits: mid } : { kind: "accept", feeUnits: ask };
    }
    return !lastRound && offer < max ? { kind: "counter", feeUnits: max } : { kind: "walk_away" };
  }
  return !lastRound && offer < max ? { kind: "counter", feeUnits: max } : { kind: "walk_away" };
}

export async function negotiate(args: {
  openingFee: number;
  maxFee: number;
  workerName: string;
  /** Ask the worker's agent about an offer at this fee. */
  decide: (offerUnits: number) => Promise<WorkerDecision>;
}): Promise<NegotiationResult> {
  const { maxFee, workerName } = args;
  let offer = args.openingFee;
  let prevAsk: number | null = null;
  let source: "llm" | "rules" = "rules";
  const t: Turn[] = [{ round: 1, from: "requester_agent", kind: "offer", feeUnits: offer, text: `Offering ${formatUsd(offer)} for this pickup.`, source: "rules" }];
  const rounds = () => t.filter((x) => x.from === "worker_agent").length;
  const end = (outcome: NegotiationResult["outcome"], feeUnits: number, summary: string): NegotiationResult =>
    ({ outcome, feeUnits, summary, transcript: t, source });

  for (let round = 1; round <= MAX_WORKER_TURNS; round++) {
    const d = await args.decide(offer);
    if (d.source === "llm") source = "llm";
    let ask: number | null = null;
    if (d.decision === "counter") {
      ask = prevAsk !== null ? Math.min(d.feeUnits, prevAsk) : d.feeUnits; // a worker's ask never goes up
    }
    t.push({ round, from: "worker_agent", kind: d.decision, feeUnits: ask ?? offer, text: d.summary, source: d.source });
    if (d.decision === "accept") {
      return end("deal", offer, round === 1 ? d.summary : `Agents agreed on ${formatUsd(offer)} after ${round} rounds. ${d.summary}`);
    }

    const move = requesterRespond({ offer, ask, max: maxFee, lastRound: round === MAX_WORKER_TURNS });
    if (move.kind === "accept") {
      t.push({ round, from: "requester_agent", kind: "accept", feeUnits: move.feeUnits, text: `Accepted ${workerName}'s ${formatUsd(move.feeUnits)}. It's within budget.`, source: "rules" });
      return end("deal", move.feeUnits, `Agents agreed on ${formatUsd(move.feeUnits)} after ${rounds()} round${rounds() === 1 ? "" : "s"} (opened at ${formatUsd(args.openingFee)}).`);
    }
    if (move.kind === "walk_away") {
      t.push({ round, from: "requester_agent", kind: "walk_away", feeUnits: offer, text: "Can't go higher. Walking away.", source: "rules" });
      return ask !== null
        ? end("over_budget", ask, `${workerName}'s agent wants ${formatUsd(ask)}, above your max. No deal.`)
        : end("no_deal", offer, `${workerName}'s agent declined even the best offer.`);
    }
    t.push({ round: round + 1, from: "requester_agent", kind: "counter", feeUnits: move.feeUnits,
      text: move.feeUnits === maxFee ? `Best I can do is ${formatUsd(move.feeUnits)}.` : `Meet in the middle at ${formatUsd(move.feeUnits)}?`, source: "rules" });
    offer = move.feeUnits;
    if (ask !== null) prevAsk = ask;
  }
  return prevAsk !== null
    ? end("over_budget", prevAsk, `No agreement after ${MAX_WORKER_TURNS} rounds.`)
    : end("no_deal", offer, `No agreement after ${MAX_WORKER_TURNS} rounds.`);
}
