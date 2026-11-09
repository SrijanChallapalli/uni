import { describe, expect, it } from "vitest";
import { estimateEffort, evaluateCandidate, rankCandidate, workerFeeBounds, type TaskInput, type TripInput, type WorkerInput } from "@/lib/matching";
import { dollarsToUnits, formatUsd } from "@/lib/money";
import { fixtureTravelMinutes } from "@/lib/locations";

const T0 = new Date("2026-11-09T22:00:00Z"); // 5:00 p.m. Eastern
const min = (m: number) => new Date(T0.getTime() + m * 60000);

const task: TaskInput = {
  id: "task", requesterId: "riley", storeId: "target_wl", deliveryZone: "earhart_windsor",
  pickupStart: T0, pickupEnd: min(75), deadline: min(120), packageSize: "small",
  offeredFee: dollarsToUnits("5"), maxFee: dollarsToUnits("7"),
};
const maya: WorkerInput = { id: "maya", displayName: "Maya", minFee: dollarsToUnits("3"), maxDetourMin: 30, completedAsWorker: 6, onTimeDeliveries: 6, cancellationsAfterAcceptance: 0, reviewCount: 6, avgRating: 4.8 };
const mayaTrip: TripInput = { id: "t1", workerId: "maya", originZone: "cary_quad", storeId: "target_wl", returnZone: "hillenbrand", departAt: min(-5), returnBy: min(115), transport: "car", capacity: "large", status: "planned" };
const now = min(-60);
const ev = (over: Partial<Parameters<typeof evaluateCandidate>[0]> = {}) =>
  evaluateCandidate({ task, trip: mayaTrip, worker: maya, commitments: [], tripHasActiveAssignment: false, now, ...over });
const codes = (e: ReturnType<typeof ev>) => e.rejects.map((r) => r.code);

describe("money", () => {
  it("parses and formats integer units", () => {
    expect(dollarsToUnits("5")).toBe(5_000_000);
    expect(dollarsToUnits("$4.5")).toBe(4_500_000);
    expect(formatUsd(4_500_000)).toBe("$4.50");
    expect(() => dollarsToUnits("4.555")).toThrow();
    expect(() => dollarsToUnits("-1")).toThrow();
  });
});

describe("feasibility", () => {
  it("accepts the seeded happy-path worker", () => {
    const e = ev();
    expect(e.feasible).toBe(true);
    expect(e.estimate!.etaDeliveryHigh <= task.deadline).toBe(true);
  });
  it("blocks self-matching", () => {
    expect(codes(ev({ trip: { ...mayaTrip, workerId: "riley" }, worker: { ...maya, id: "riley" } }))).toContain("self_match");
  });
  it("rejects a trip to another store", () => {
    expect(codes(ev({ trip: { ...mayaTrip, storeId: "cvs_state" } }))).toContain("wrong_store");
  });
  it("rejects a worker who arrives after the window / misses the deadline", () => {
    const late = ev({ trip: { ...mayaTrip, departAt: min(85), transport: "bike", capacity: "medium" } });
    expect(late.feasible).toBe(false);
    expect(codes(late)).toEqual(expect.arrayContaining(["too_late"]));
  });
  it("enforces capacity by both stated capacity and transport mode", () => {
    expect(codes(ev({ task: { ...task, packageSize: "large" }, trip: { ...mayaTrip, transport: "bike", capacity: "large" } }))).toContain("too_big");
  });
  it("limits brand-new workers to small packages", () => {
    const fresh = { ...maya, completedAsWorker: 0, reviewCount: 0, avgRating: null };
    expect(ev({ worker: fresh }).feasible).toBe(true);
    expect(codes(ev({ worker: fresh, task: { ...task, packageSize: "medium" } }))).toContain("new_worker_size_limit");
  });
  it("enforces the worker's max extra effort", () => {
    expect(codes(ev({ worker: { ...maya, maxDetourMin: 5 } }))).toContain("too_much_detour");
  });
  it("prevents overbooking a trip and conflicting commitments", () => {
    expect(codes(ev({ tripHasActiveAssignment: true }))).toContain("trip_full");
    expect(codes(ev({ commitments: [{ tripId: "other", windowStart: min(0), windowEnd: min(60) }] }))).toContain("schedule_conflict");
    expect(ev({ commitments: [{ tripId: "other", windowStart: min(200), windowEnd: min(260) }] }).feasible).toBe(true);
  });
  it("filters when the worker's minimum fee exceeds the budget", () => {
    expect(codes(ev({ worker: { ...maya, minFee: dollarsToUnits("9") } }))).toContain("over_budget");
  });
  it("rejects trips that already happened", () => {
    expect(codes(ev({ now: min(60) }))).toContain("trip_in_past");
  });
});

describe("effort estimate", () => {
  it("separates extra effort from total trip duration and labels fixtures", () => {
    const e = estimateEffort(task, mayaTrip);
    expect(e.source).toBe("fixture");
    expect(e.extraLowMin).toBeLessThan(e.extraHighMin);
    expect(e.tripTotalHighMin).toBe(e.baselineTripMin + e.extraHighMin);
    expect(e.assumptions.join(" ")).toMatch(/not live traffic/);
  });
  it("counts waiting for the pickup window as effort", () => {
    const early = estimateEffort(task, { ...mayaTrip, departAt: min(-25) });
    expect(early.waitForWindowMin).toBeGreaterThan(0);
    expect(early.extraLowMin).toBeGreaterThan(estimateEffort(task, mayaTrip).extraLowMin);
  });
  it("is symmetric-ish and deterministic for fixtures", () => {
    expect(fixtureTravelMinutes("target_wl", "hillenbrand", "car")).toBe(fixtureTravelMinutes("target_wl", "hillenbrand", "car"));
    expect(fixtureTravelMinutes("pmu", "pmu", "walk")).toBe(0);
  });
});

describe("fee bounds & ranking", () => {
  const est = estimateEffort(task, mayaTrip);
  it("allows accepting when the offer covers the minimum", () => {
    expect(workerFeeBounds(task, maya, est).canAccept).toBe(true);
  });
  it("allows one bounded counter when the offer is below the minimum", () => {
    const b = workerFeeBounds(task, { ...maya, minFee: dollarsToUnits("6") }, est);
    expect(b.canAccept).toBe(false);
    expect(b.counter).toEqual({ min: dollarsToUnits("6"), max: dollarsToUnits("7.5") });
  });
  it("forbids counters far above the offer", () => {
    expect(workerFeeBounds(task, { ...maya, minFee: dollarsToUnits("20") }, est).counter).toBeNull();
  });
  it("ranks cheaper, faster, reputable offers higher and explains why", () => {
    const a = rankCandidate(task, maya, est, task.offeredFee);
    const b = rankCandidate(task, { ...maya, completedAsWorker: 0, reviewCount: 0, avgRating: null, onTimeDeliveries: 0 }, est, dollarsToUnits("7"));
    expect(a.total).toBeGreaterThan(b.total);
    expect(a.notes.length).toBe(4);
  });
});
