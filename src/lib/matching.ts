// Deterministic feasibility, effort estimation, fee bounds and ranking.
// The LLM never decides feasibility, money bounds, capacity or schedule conflicts: this file does.
import { fixtureTravelMinutes, MODE_MAX_SIZE, SIZE_RANK, type Mode, type PackageSize } from "./locations";
import { ceilToCent, floorToCent, UNITS_PER_CENT } from "./money";

export interface TaskInput {
  id: string;
  requesterId: string;
  storeId: string;
  deliveryZone: string;
  pickupStart: Date;
  pickupEnd: Date;
  deadline: Date;
  packageSize: PackageSize;
  offeredFee: number; // units
  maxFee: number; // units (private to requester)
}

export interface TripInput {
  id: string;
  workerId: string;
  originZone: string;
  storeId: string;
  returnZone: string;
  departAt: Date;
  returnBy: Date;
  transport: Mode;
  capacity: PackageSize;
  status: string;
}

export interface WorkerInput {
  id: string;
  displayName: string;
  minFee: number;
  maxDetourMin: number;
  completedAsWorker: number;
  onTimeDeliveries: number;
  cancellationsAfterAcceptance: number;
  reviewCount: number;
  avgRating: number | null;
}

export interface Commitment { tripId: string; windowStart: Date; windowEnd: Date }

export interface EffortEstimate {
  source: "fixture";
  arriveStoreAt: Date;
  pickupAt: Date;
  waitForWindowMin: number;
  addedTravelMin: number;
  extraLowMin: number;
  extraHighMin: number;
  tripTotalLowMin: number;
  tripTotalHighMin: number;
  baselineTripMin: number;
  etaDeliveryLow: Date;
  etaDeliveryHigh: Date;
  slackMin: number;
  assumptions: string[];
}

export type RejectCode =
  | "self_match" | "trip_not_planned" | "wrong_store" | "too_early" | "too_late" | "trip_in_past"
  | "misses_deadline" | "too_big" | "too_much_detour" | "over_budget" | "trip_full"
  | "schedule_conflict" | "new_worker_size_limit";

export interface Evaluation {
  tripId: string;
  workerId: string;
  feasible: boolean;
  rejects: { code: RejectCode; message: string }[];
  estimate: EffortEstimate | null;
}

export const PICKUP_WAIT_MIN = { low: 4, high: 10 };
export const HANDOFF_MIN = { low: 2, high: 5 };
export const MAX_EARLY_WAIT_MIN = 20;
export const TRAVEL_UNCERTAINTY = 1.25;

const minutes = (ms: number) => Math.round(ms / 60000);
const addMin = (d: Date, m: number) => new Date(d.getTime() + m * 60000);

export function estimateEffort(task: TaskInput, trip: TripInput): EffortEstimate {
  const mode = trip.transport;
  const toStore = fixtureTravelMinutes(trip.originZone, trip.storeId, mode);
  const baselineReturn = fixtureTravelMinutes(trip.storeId, trip.returnZone, mode);
  const storeToDelivery = fixtureTravelMinutes(trip.storeId, task.deliveryZone, mode);
  const deliveryToReturn = fixtureTravelMinutes(task.deliveryZone, trip.returnZone, mode);

  const arriveStoreAt = addMin(trip.departAt, toStore);
  const pickupAt = arriveStoreAt < task.pickupStart ? task.pickupStart : arriveStoreAt;
  const waitForWindowMin = Math.max(0, minutes(pickupAt.getTime() - arriveStoreAt.getTime()));
  const addedTravelMin = Math.max(0, storeToDelivery + deliveryToReturn - baselineReturn);

  const coreLow = addedTravelMin + PICKUP_WAIT_MIN.low + HANDOFF_MIN.low + waitForWindowMin;
  const coreHigh = Math.ceil(addedTravelMin * TRAVEL_UNCERTAINTY) + PICKUP_WAIT_MIN.high + HANDOFF_MIN.high + waitForWindowMin;
  const buffer = Math.max(3, Math.ceil(coreHigh * 0.2));
  const extraLowMin = coreLow;
  const extraHighMin = coreHigh + buffer;

  const baselineTripMin = toStore + baselineReturn;
  const etaDeliveryLow = addMin(pickupAt, PICKUP_WAIT_MIN.low + storeToDelivery);
  const etaDeliveryHigh = addMin(pickupAt, PICKUP_WAIT_MIN.high + Math.ceil(storeToDelivery * TRAVEL_UNCERTAINTY) + buffer);

  return {
    source: "fixture",
    arriveStoreAt,
    pickupAt,
    waitForWindowMin,
    addedTravelMin,
    extraLowMin,
    extraHighMin,
    tripTotalLowMin: baselineTripMin + extraLowMin,
    tripTotalHighMin: baselineTripMin + extraHighMin,
    baselineTripMin,
    etaDeliveryLow,
    etaDeliveryHigh,
    slackMin: minutes(task.deadline.getTime() - etaDeliveryHigh.getTime()),
    assumptions: [
      `Travel times are fixture estimates for seeded campus locations (${mode}), not live traffic.`,
      `Pickup counter wait ${PICKUP_WAIT_MIN.low}–${PICKUP_WAIT_MIN.high} min; handoff ${HANDOFF_MIN.low}–${HANDOFF_MIN.high} min.`,
      `Upper bound adds ${Math.round((TRAVEL_UNCERTAINTY - 1) * 100)}% travel uncertainty and a ${buffer}-min buffer.`,
      ...(waitForWindowMin > 0 ? [`Includes ${waitForWindowMin} min waiting for the pickup window to open.`] : []),
    ],
  };
}

const overlaps = (a0: Date, a1: Date, b0: Date, b1: Date) => a0 < b1 && b0 < a1;

export function evaluateCandidate(args: {
  task: TaskInput;
  trip: TripInput;
  worker: WorkerInput;
  commitments: Commitment[]; // worker's active assignments (any trip)
  tripHasActiveAssignment: boolean;
  now: Date;
}): Evaluation {
  const { task, trip, worker, commitments, now } = args;
  const rejects: Evaluation["rejects"] = [];
  const no = (code: RejectCode, message: string) => rejects.push({ code, message });

  if (worker.id !== trip.workerId) throw new Error("worker/trip mismatch");
  if (trip.workerId === task.requesterId) no("self_match", "You can't take your own request.");
  if (trip.status !== "planned") no("trip_not_planned", "Trip is no longer planned.");
  if (trip.storeId !== task.storeId) no("wrong_store", "Trip doesn't visit this store.");
  if (args.tripHasActiveAssignment) no("trip_full", "Trip already carries another task (bundling not supported yet).");

  const carry = Math.min(SIZE_RANK[trip.capacity], SIZE_RANK[MODE_MAX_SIZE[trip.transport]]);
  if (SIZE_RANK[task.packageSize] > carry) no("too_big", `Package is ${task.packageSize}; this trip can carry less.`);
  if (worker.completedAsWorker === 0 && task.packageSize !== "small")
    no("new_worker_size_limit", "New workers start with small packages only.");
  if (worker.minFee > task.maxFee) no("over_budget", "Worker's minimum fee is above the requester's budget.");

  let estimate: EffortEstimate | null = null;
  if (trip.storeId === task.storeId) {
    estimate = estimateEffort(task, trip);
    if (estimate.arriveStoreAt < now) no("trip_in_past", "Trip reaches the store before now.");
    if (estimate.arriveStoreAt > task.pickupEnd) no("too_late", "Arrives at the store after the pickup window closes.");
    if (task.pickupStart.getTime() - estimate.arriveStoreAt.getTime() > MAX_EARLY_WAIT_MIN * 60000)
      no("too_early", `Arrives more than ${MAX_EARLY_WAIT_MIN} min before the pickup window opens.`);
    if (estimate.etaDeliveryHigh > task.deadline) no("misses_deadline", "Can't guarantee delivery before the deadline.");
    if (estimate.extraHighMin > worker.maxDetourMin)
      no("too_much_detour", `Up to ${estimate.extraHighMin} extra min exceeds this worker's ${worker.maxDetourMin}-min limit.`);
    const conflict = commitments.find(
      (c) => c.tripId !== trip.id && overlaps(c.windowStart, c.windowEnd, estimate!.pickupAt, estimate!.etaDeliveryHigh),
    );
    if (conflict) no("schedule_conflict", "Overlaps another job this worker already accepted.");
  }

  return { tripId: trip.id, workerId: worker.id, feasible: rejects.length === 0, rejects, estimate };
}

// ------------------------------------------------------------------ fee bounds for the worker agent
export interface FeeBounds {
  canAccept: boolean;
  /** Inclusive counteroffer range in units, or null when no counter is allowed. */
  counter: { min: number; max: number } | null;
}

export function workerFeeBounds(task: TaskInput, worker: WorkerInput, est: EffortEstimate): FeeBounds {
  const offered = task.offeredFee;
  const cap = floorToCent(Math.floor(offered * 1.5));
  if (offered >= worker.minFee) {
    // Accepting is allowed. A counter is only allowed when the job uses most of the worker's detour budget.
    const heavy = est.extraHighMin >= worker.maxDetourMin * 0.75;
    const min = offered + UNITS_PER_CENT;
    const max = floorToCent(Math.floor(offered * 1.25));
    return { canAccept: true, counter: heavy && max >= min ? { min, max } : null };
  }
  const min = ceilToCent(worker.minFee);
  return { canAccept: false, counter: min <= cap ? { min, max: cap } : null };
}

// ------------------------------------------------------------------ ranking
export interface RankFactors {
  effort: number;
  timing: number;
  price: number;
  reputation: number;
  total: number;
  notes: string[];
}

export function reputationScore(w: WorkerInput): { score: number; note: string } {
  if (w.completedAsWorker === 0 && w.reviewCount === 0) return { score: 0.6, note: "New worker — no history yet" };
  const prior = 4.0, k = 3;
  const bayes = ((w.avgRating ?? prior) * w.reviewCount + prior * k) / (w.reviewCount + k) / 5;
  const onTime = w.completedAsWorker > 0 ? w.onTimeDeliveries / w.completedAsWorker : 0.8;
  const cancelPenalty = Math.min(0.3, w.cancellationsAfterAcceptance * 0.1);
  const score = Math.max(0, Math.min(1, 0.6 * bayes + 0.4 * onTime - cancelPenalty));
  return {
    score,
    note: `${w.reviewCount} review${w.reviewCount === 1 ? "" : "s"}${w.avgRating ? `, ${w.avgRating.toFixed(1)}★` : ""}; ${w.onTimeDeliveries}/${w.completedAsWorker} on time`,
  };
}

export function rankCandidate(task: TaskInput, worker: WorkerInput, est: EffortEstimate, feeUnits: number): RankFactors {
  const effort = Math.max(0, 1 - est.extraHighMin / Math.max(30, worker.maxDetourMin));
  const timing = Math.max(0, Math.min(1, est.slackMin / 60));
  const span = Math.max(UNITS_PER_CENT, task.maxFee - task.offeredFee);
  const price = Math.max(0, Math.min(1, 1 - (feeUnits - task.offeredFee) / span));
  const rep = reputationScore(worker);
  const total = Math.round((0.35 * effort + 0.2 * timing + 0.25 * price + 0.2 * rep.score) * 100);
  return {
    effort, timing, price, reputation: rep.score, total,
    notes: [
      `Route fit: ${est.extraLowMin}–${est.extraHighMin} extra min on a trip already going to the store`,
      `Timing: ${est.slackMin} min of slack before your deadline`,
      feeUnits <= task.offeredFee ? "Price: at your offered fee" : "Price: counteroffer above your offered fee",
      `Reputation: ${rep.note}`,
    ],
  };
}
