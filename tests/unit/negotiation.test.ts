import { describe, expect, it } from "vitest";
import { negotiate, requesterRespond, MAX_WORKER_TURNS } from "@/lib/agents/negotiation";
import type { WorkerDecision } from "@/lib/agents/worker";

const $ = (d: number) => Math.round(d * 100) * 10_000;

/** A worker agent with a private minimum: accepts at or above it, otherwise counters at it. */
const workerWithMin = (min: number, seen: number[] = []) => async (offer: number): Promise<WorkerDecision> => {
  seen.push(offer);
  return offer >= min
    ? { decision: "accept", feeUnits: offer, summary: "ok", source: "rules" }
    : { decision: "counter", feeUnits: min, summary: "need more", source: "rules" };
};

describe("requesterRespond (deterministic requester agent)", () => {
  it("accepts a counter within budget when the gap is small", () => {
    expect(requesterRespond({ offer: $(5), ask: $(5.5), max: $(7), lastRound: false })).toEqual({ kind: "accept", feeUnits: $(5.5) });
  });
  it("meets in the middle on a bigger gap", () => {
    expect(requesterRespond({ offer: $(5), ask: $(6.5), max: $(7), lastRound: false })).toEqual({ kind: "counter", feeUnits: $(5.75) });
  });
  it("offers its max once when the ask is over budget, then walks away", () => {
    expect(requesterRespond({ offer: $(5), ask: $(9), max: $(7), lastRound: false })).toEqual({ kind: "counter", feeUnits: $(7) });
    expect(requesterRespond({ offer: $(7), ask: $(9), max: $(7), lastRound: false })).toEqual({ kind: "walk_away" });
  });
  it("never exceeds max", () => {
    for (const ask of [$(5.01), $(6), $(6.99), $(7), $(7.01), $(20)]) {
      const m = requesterRespond({ offer: $(5), ask, max: $(7), lastRound: false });
      if (m.kind !== "walk_away") expect(m.feeUnits).toBeLessThanOrEqual($(7));
    }
  });
});

describe("negotiate (agent-to-agent)", () => {
  it("closes in one round when the opening offer is enough", async () => {
    const r = await negotiate({ openingFee: $(5), maxFee: $(7), workerName: "Maya", decide: workerWithMin($(3)) });
    expect(r).toMatchObject({ outcome: "deal", feeUnits: $(5) });
    expect(r.transcript).toHaveLength(2);
  });

  it("goes back and forth and settles between opening and max", async () => {
    const seen: number[] = [];
    const r = await negotiate({ openingFee: $(5), maxFee: $(7), workerName: "Nia", decide: workerWithMin($(6.5), seen) });
    expect(r.outcome).toBe("deal");
    expect(r.feeUnits).toBe($(6.5));
    expect(seen).toEqual([$(5), $(5.75)]); // worker agent only ever saw offers, never the max
    expect(r.transcript.map((t) => `${t.from}:${t.kind}`)).toEqual([
      "requester_agent:offer", "worker_agent:counter", "requester_agent:counter", "worker_agent:counter", "requester_agent:accept",
    ]);
  });

  it("walks away when the worker needs more than the max", async () => {
    const r = await negotiate({ openingFee: $(5), maxFee: $(7), workerName: "X", decide: workerWithMin($(9)) });
    expect(r.outcome).toBe("over_budget");
    expect(r.transcript.filter((t) => t.from === "requester_agent" && t.feeUnits > $(7))).toHaveLength(0);
  });

  it("stops after a fixed number of worker turns and the worker's ask never rises", async () => {
    let n = 0;
    const greedy = async (): Promise<WorkerDecision> => ({ decision: "counter", feeUnits: $(6) + n++ * $(1), summary: "more", source: "llm" });
    const r = await negotiate({ openingFee: $(5), maxFee: $(10), workerName: "G", decide: greedy });
    const asks = r.transcript.filter((t) => t.from === "worker_agent").map((t) => t.feeUnits);
    expect(asks.length).toBeLessThanOrEqual(MAX_WORKER_TURNS);
    expect(asks.every((a, i) => i === 0 || a <= asks[i - 1])).toBe(true);
    expect(r.outcome).toBe("deal");
    expect(r.feeUnits).toBe($(6));
  });

  it("raises once to max after a flat rejection", async () => {
    const seen: number[] = [];
    const picky = async (offer: number): Promise<WorkerDecision> => {
      seen.push(offer);
      return offer >= $(7) ? { decision: "accept", feeUnits: offer, summary: "ok", source: "rules" } : { decision: "reject", feeUnits: offer, summary: "no", source: "rules" };
    };
    const r = await negotiate({ openingFee: $(4), maxFee: $(7), workerName: "P", decide: picky });
    expect(seen).toEqual([$(4), $(7)]);
    expect(r).toMatchObject({ outcome: "deal", feeUnits: $(7) });
  });
});
