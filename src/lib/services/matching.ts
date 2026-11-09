import "server-only";
import { recommend, type CandidateForRecommendation } from "../agents/requester";
import { negotiate, type NegotiationResult } from "../agents/negotiation";
import { workerDecide } from "../agents/worker";
import { one, pool, q, tx, type Db } from "../db";
import {
  evaluateCandidate, rankCandidate, reputationScore, workerFeeBounds,
  type Commitment, type Evaluation, type TaskInput, type TripInput, type WorkerInput,
} from "../matching";
import type { Profile, Reputation, Task, Trip } from "../types";
import { logEvent, UserError } from "./common";

export const OFFER_TTL_MIN = 30;

export function taskInput(t: Task): TaskInput {
  return {
    id: t.id, requesterId: t.requester_id, storeId: t.store_id, deliveryZone: t.delivery_zone,
    pickupStart: new Date(t.pickup_window_start), pickupEnd: new Date(t.pickup_window_end), deadline: new Date(t.delivery_deadline),
    packageSize: t.package_size, offeredFee: t.offered_fee_units, maxFee: t.max_fee_units,
  };
}

export function tripInput(t: Trip): TripInput {
  return {
    id: t.id, workerId: t.worker_id, originZone: t.origin_zone, storeId: t.store_id, returnZone: t.return_zone,
    departAt: new Date(t.depart_at), returnBy: new Date(t.return_by), transport: t.transport, capacity: t.capacity, status: t.status,
  };
}

export function workerInput(p: Profile, r: Reputation | null): WorkerInput {
  return {
    id: p.id, displayName: p.display_name, minFee: p.min_fee_units, maxDetourMin: p.max_detour_min,
    completedAsWorker: r?.completed_as_worker ?? 0, onTimeDeliveries: r?.on_time_deliveries ?? 0,
    cancellationsAfterAcceptance: r?.cancellations_after_acceptance ?? 0,
    reviewCount: r?.worker_review_count ?? 0, avgRating: r?.worker_avg_rating ?? null,
  };
}

/** Load everything needed to evaluate one trip for one task, inside db (optionally locked). */
export async function evaluateTrip(db: Db, task: Task, tripId: string, now: Date, lockTrip = false): Promise<{ ev: Evaluation; worker: WorkerInput; trip: Trip }> {
  const trip = await one<Trip>(`select * from trips where id = $1${lockTrip ? " for update" : ""}`, [tripId], db);
  if (!trip) throw new UserError("Trip no longer exists.");
  const prof = await one<Profile>("select * from profiles where id = $1", [trip.worker_id], db);
  const rep = await one<Reputation>("select * from reputation where profile_id = $1", [trip.worker_id], db);
  const commitments = await q<{ trip_id: string; window_start: Date; window_end: Date }>(
    "select trip_id, window_start, window_end from assignments where worker_id = $1 and active and task_id <> $2", [trip.worker_id, task.id], db);
  const busy = await one("select 1 from assignments where trip_id = $1 and active and task_id <> $2", [trip.id, task.id], db);
  const worker = workerInput(prof!, rep);
  const ev = evaluateCandidate({
    task: taskInput(task), trip: tripInput(trip), worker,
    commitments: commitments.map<Commitment>((c) => ({ tripId: c.trip_id, windowStart: new Date(c.window_start), windowEnd: new Date(c.window_end) })),
    tripHasActiveAssignment: Boolean(busy), now,
  });
  return { ev, worker, trip };
}

export interface MatchRunResult {
  feasible: number;
  filtered: { code: string; message: string }[];
  recommendation: { offerId: string | null; summary: string; tradeoffs: string[]; source: string };
}

export async function runMatching(taskId: string, viewerId: string, now = new Date()): Promise<MatchRunResult> {
  const task = await one<Task>("select * from tasks where id = $1", [taskId]);
  if (!task) throw new UserError("Task not found.");
  if (task.requester_id !== viewerId) throw new UserError("Only the requester can run matching.");
  if (task.status !== "open") throw new UserError("Matching is only available while the request is open.");

  // Candidate trips: same store, not the requester's own, departing in a plausible window.
  const trips = await q<{ id: string }>(
    `select t.id from trips t join profiles w on w.id = t.worker_id
       where t.status = 'planned' and t.store_id = $1 and t.worker_id <> $2
         and w.is_demo = (select is_demo from profiles where id = $2) -- demo personas never match real users
         and t.depart_at between $3::timestamptz - interval '3 hours' and $4`,
    [task.store_id, task.requester_id, task.pickup_window_start, task.delivery_deadline]);

  const filtered: MatchRunResult["filtered"] = [];
  const offers: { tripId: string; workerId: string; ev: Evaluation; worker: WorkerInput; neg: NegotiationResult }[] = [];
  const ti = taskInput(task);
  for (const { id } of trips) {
    const { ev, worker } = await evaluateTrip(pool(), task, id, now);
    if (!ev.feasible || !ev.estimate) {
      filtered.push(...ev.rejects.slice(0, 1));
      continue;
    }
    // Agent-to-agent negotiation. The worker agent sees only this worker's trip + preferences and the
    // current offer — never the requester's max fee. Its fee range is recomputed for every offer.
    const est = ev.estimate;
    const neg = await negotiate({
      openingFee: ti.offeredFee, maxFee: ti.maxFee, workerName: worker.displayName.split(" ")[0],
      decide: (offer) => {
        const at = { ...ti, offeredFee: offer };
        return workerDecide(at, worker, est, workerFeeBounds(at, worker, est), task.instructions);
      },
    });
    offers.push({ tripId: id, workerId: worker.id, ev, worker, neg });
  }

  return tx(async (c) => {
    const locked = await one<Task>("select * from tasks where id = $1 for update", [taskId], c);
    if (!locked || locked.status !== "open" || locked.terms_version !== task.terms_version) throw new UserError("The request changed while matching. Try again.");
    await q("update offers set status = 'superseded' where task_id = $1 and status = 'proposed'", [taskId], c);

    const cands: CandidateForRecommendation[] = [];
    for (const o of offers) {
      const est = o.ev.estimate!;
      const decision = o.neg.outcome === "deal" ? "accept" : o.neg.outcome === "over_budget" ? "counter" : "reject";
      const factors = rankCandidate(ti, o.worker, est, o.neg.feeUnits);
      const withinBudget = decision === "accept" && o.neg.feeUnits <= task.max_fee_units;
      const rounds = o.neg.transcript.filter((t) => t.from === "worker_agent").length;
      const row = await one<{ id: string }>(
        `insert into offers (task_id, worker_id, trip_id, task_terms_version, decision, fee_units, effort_low_min, effort_high_min,
           trip_total_min, eta_delivery, score, factors, summary, agent_source, status, expires_at, transcript)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
        [taskId, o.workerId, o.tripId, task.terms_version, decision, o.neg.feeUnits, est.extraLowMin, est.extraHighMin,
          est.tripTotalHighMin, est.etaDeliveryHigh, factors.total,
          JSON.stringify({ notes: factors.notes, assumptions: est.assumptions, total: factors.total, withinBudget, baselineTripMin: est.baselineTripMin, tripTotalLowMin: est.tripTotalLowMin, slackMin: est.slackMin, pickupAt: est.pickupAt }),
          o.neg.summary, o.neg.source, decision === "reject" ? "declined" : "proposed",
          new Date(now.getTime() + OFFER_TTL_MIN * 60000), JSON.stringify(o.neg.transcript)], c);
      if (decision !== "reject") {
        cands.push({
          offerId: row!.id, workerName: o.worker.displayName.split(" ")[0], decision, feeUnits: o.neg.feeUnits, rounds,
          withinBudget, score: factors.total, extraLow: est.extraLowMin, extraHigh: est.extraHighMin, slackMin: est.slackMin,
          reputationNote: reputationScore(o.worker).note,
        });
      }
    }
    const rec = await recommend(cands, task.max_fee_units);
    await q("insert into match_runs (task_id, candidates, recommendation, agent_source) values ($1,$2,$3,$4)",
      [taskId, JSON.stringify({ evaluated: trips.length, feasible: offers.length, filtered }), JSON.stringify(rec), rec.source], c);
    await logEvent(c, taskId, viewerId, "matched", `Agents evaluated ${trips.length} trip(s); ${cands.length} offer(s) ready.`);
    return { feasible: offers.length, filtered, recommendation: rec };
  });
}
