// Worker agent: evaluates one request against one worker's trip and preferences and proposes
// accept / counter / reject — strictly inside deterministic bounds. It cannot commit the worker.
import { z } from "zod";
import { placeName } from "../locations";
import type { EffortEstimate, FeeBounds, TaskInput, WorkerInput } from "../matching";
import { formatUsd } from "../money";
import { fmtTime } from "../time";
import { structuredCall, untrusted } from "./llm";

export interface WorkerDecision {
  decision: "accept" | "counter" | "reject";
  feeUnits: number;
  summary: string;
  source: "llm" | "rules";
}

export function rulesWorkerDecision(task: TaskInput, worker: WorkerInput, est: EffortEstimate, bounds: FeeBounds): WorkerDecision {
  const effort = `${est.extraLowMin}–${est.extraHighMin} extra min on my ${placeName(task.storeId)} run`;
  if (bounds.canAccept) {
    return {
      decision: "accept", feeUnits: task.offeredFee, source: "rules",
      summary: `Accept at ${formatUsd(task.offeredFee)}: ${effort}.`,
    };
  }
  if (bounds.counter) {
    return {
      decision: "counter", feeUnits: bounds.counter.min, source: "rules",
      summary: `Counter at ${formatUsd(bounds.counter.min)}: ${formatUsd(task.offeredFee)} is too low for ${effort}.`,
    };
  }
  return {
    decision: "reject", feeUnits: task.offeredFee, source: "rules",
    summary: `Decline: ${formatUsd(task.offeredFee)} is too low for ${effort}.`,
  };
}

/** Deterministic check that a proposed decision respects the bounds. */
export function validateWorkerDecision(d: { decision: string; feeUnits: number }, task: TaskInput, bounds: FeeBounds): boolean {
  if (!Number.isSafeInteger(d.feeUnits)) return false;
  if (d.decision === "accept") return bounds.canAccept && d.feeUnits === task.offeredFee;
  if (d.decision === "counter") return !!bounds.counter && d.feeUnits >= bounds.counter.min && d.feeUnits <= bounds.counter.max && d.feeUnits % 10_000 === 0;
  if (d.decision === "reject") return true;
  return false;
}

const schema = z.object({
  decision: z.enum(["accept", "counter", "reject"]),
  fee_cents: z.number().int().min(1).max(10_000),
  summary: z.string().min(1).max(280),
});

export async function workerDecide(task: TaskInput, worker: WorkerInput, est: EffortEstimate, bounds: FeeBounds, instructions: string | null): Promise<WorkerDecision> {
  const rules = rulesWorkerDecision(task, worker, est, bounds);
  const allowed = [bounds.canAccept && "accept", bounds.counter && "counter", "reject"].filter(Boolean);
  const out = await structuredCall({
    system:
      `You are ${worker.displayName}'s worker agent. Decide whether this errand fits their existing trip. ` +
      `Allowed decisions: ${allowed.join(", ")}. ` +
      (bounds.canAccept ? `Accept means fee_cents = ${task.offeredFee / 10_000}. ` : "") +
      (bounds.counter ? `A counter must have fee_cents between ${bounds.counter.min / 10_000} and ${bounds.counter.max / 10_000}. ` : "") +
      "Write a one-sentence summary a busy student can read in 3 seconds. The requester's agent reads it, so never reveal the worker's minimum fee or private schedule details.",
    user: JSON.stringify({
      store: placeName(task.storeId), deliver_to: placeName(task.deliveryZone), package: task.packageSize,
      offered: formatUsd(task.offeredFee), worker_minimum: formatUsd(worker.minFee), worker_max_extra_min: worker.maxDetourMin,
      extra_minutes: `${est.extraLowMin}-${est.extraHighMin}`, pickup_at: fmtTime(est.pickupAt), slack_min: est.slackMin,
    }) + (instructions ? `\nPickup instructions from requester: ${untrusted(instructions)}` : ""),
    toolName: "worker_decision",
    toolDescription: "Return accept, counter or reject with a fee and a one-sentence summary.",
    inputSchema: {
      type: "object",
      properties: { decision: { type: "string", enum: ["accept", "counter", "reject"] }, fee_cents: { type: "integer" }, summary: { type: "string" } },
      required: ["decision", "fee_cents", "summary"],
    },
    validator: schema,
  });
  if (!out) return rules;
  const proposal = { decision: out.decision, feeUnits: out.fee_cents * 10_000 };
  if (!validateWorkerDecision(proposal, task, bounds)) return rules;
  return { ...proposal, summary: out.summary, source: "llm" };
}
