import { describe, expect, it } from "vitest";
import { buildTerms, hashTerms, isFullyApproved, materialChanges } from "@/lib/agreement";
import { applyConfirmedEvent, assertCanRequest, clearsPending, PaymentTransitionError, type PaymentStatus } from "@/lib/escrow/state";
import { codeMatches, decideAttempt, deriveCode, hashCode, MAX_ATTEMPTS, normalizeCode } from "@/lib/handoff";

describe("escrow state machine", () => {
  it("follows the happy path only on confirmed events", () => {
    let s: PaymentStatus = "awaiting_funding";
    for (const [type, next] of [["Funded", "funded"], ["Released", "released"]] as const) {
      const r = applyConfirmedEvent(s, { type });
      expect(r).toMatchObject({ kind: "applied", next });
      s = next;
    }
  });
  it("prevents double funding, double release and duplicate refunds at request time", () => {
    expect(() => assertCanRequest({ status: "funded", pendingAction: null }, "fund")).toThrow(PaymentTransitionError);
    expect(() => assertCanRequest({ status: "released", pendingAction: null }, "release")).toThrow();
    expect(() => assertCanRequest({ status: "refunded", pendingAction: null }, "refund")).toThrow();
    expect(() => assertCanRequest({ status: "awaiting_funding", pendingAction: "fund" }, "fund")).toThrow(/pending/);
    expect(() => assertCanRequest({ status: "funded", pendingAction: "release" }, "refund")).toThrow(/pending/);
  });
  it("treats repeated callbacks as idempotent duplicates", () => {
    expect(applyConfirmedEvent("funded", { type: "Funded" })).toEqual({ kind: "duplicate" });
    expect(applyConfirmedEvent("released", { type: "Released" })).toEqual({ kind: "duplicate" });
    expect(applyConfirmedEvent("refunded", { type: "Refunded" })).toEqual({ kind: "duplicate" });
  });
  it("rejects impossible orderings", () => {
    expect(applyConfirmedEvent("awaiting_funding", { type: "Released" }).kind).toBe("invalid");
    expect(applyConfirmedEvent("released", { type: "Refunded" }).kind).toBe("invalid");
    expect(applyConfirmedEvent("refunded", { type: "Released" }).kind).toBe("invalid");
  });
  it("freezes on dispute: no release, only resolution", () => {
    expect(() => assertCanRequest({ status: "disputed", pendingAction: null }, "release")).toThrow();
    expect(() => assertCanRequest({ status: "disputed", pendingAction: null }, "refund")).toThrow();
    expect(applyConfirmedEvent("disputed", { type: "Released" }).kind).toBe("invalid");
    expect(applyConfirmedEvent("disputed", { type: "Resolved", toWorker: true })).toMatchObject({ kind: "applied", next: "released", resolvedByResolver: true });
    expect(applyConfirmedEvent("disputed", { type: "Resolved", toWorker: false })).toMatchObject({ kind: "applied", next: "refunded" });
  });
  it("clears only the matching pending action", () => {
    expect(clearsPending("fund", { type: "Funded" })).toBe(true);
    expect(clearsPending("release", { type: "Funded" })).toBe(false);
    expect(clearsPending("resolve_requester", { type: "Resolved", toWorker: false })).toBe(true);
  });
});

describe("agreement versions", () => {
  const base = buildTerms({
    taskId: "t", requesterId: "r", workerId: "w", tripId: "trip", storeId: "target_wl", deliveryZone: "earhart_windsor", packageSize: "small",
    feeUnits: 5_000_000, pickupWindowStart: "2026-11-09T22:00:00.000Z", pickupWindowEnd: "2026-11-09T23:15:00.000Z", deliveryDeadline: "2026-11-10T00:00:00.000Z",
  });
  it("hashes deterministically regardless of key order", () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as typeof base;
    expect(hashTerms(reordered)).toBe(hashTerms(base));
  });
  it("detects material changes", () => {
    expect(materialChanges(base, { ...base, feeUnits: 6_000_000 })).toEqual(["feeUnits"]);
    expect(materialChanges(base, { ...base })).toEqual([]);
  });
  it("requires both parties on the same current version and hash", () => {
    const h1 = hashTerms(base);
    const h2 = hashTerms({ ...base, feeUnits: 6_000_000 });
    const approvals = [{ version: 1, profileId: "r", termsHash: h1 }, { version: 1, profileId: "w", termsHash: h1 }];
    expect(isFullyApproved({ currentVersion: 1, currentHash: h1, requesterId: "r", workerId: "w", approvals })).toBe(true);
    // An edit to v2 invalidates v1 approvals.
    expect(isFullyApproved({ currentVersion: 2, currentHash: h2, requesterId: "r", workerId: "w", approvals: [...approvals, { version: 2, profileId: "w", termsHash: h2 }] })).toBe(false);
    expect(isFullyApproved({ currentVersion: 1, currentHash: h1, requesterId: "r", workerId: "w", approvals: [approvals[0]] })).toBe(false);
  });
  it("discloses resolver and timeouts in every agreement", () => {
    expect(base.disputeResolver).toMatch(/centralized/);
    expect(base.timeouts.resolveHours).toBe(72);
    expect(base.completionMethod).toMatch(/not package contents/);
  });
});

describe("handoff code", () => {
  it("verifies against a stored hash, never the code", () => {
    const code = deriveCode("task-1", "salt");
    expect(code).toMatch(/^\d{6}$/);
    const stored = hashCode("task-1", code);
    expect(stored).not.toContain(code);
    expect(codeMatches("task-1", code, stored)).toBe(true);
    expect(codeMatches("task-1", `${code.slice(0, 3)} ${code.slice(3)}`, stored)).toBe(true);
    expect(codeMatches("task-2", code, stored)).toBe(false);
    expect(normalizeCode("12a456")).toBeNull();
  });
  it("rate-limits and locks after repeated failures", () => {
    const now = new Date();
    let row = { attempts: 0, lockedUntil: null as Date | null, usedAt: null as Date | null };
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const r = decideAttempt(row, false, now);
      expect(r.decision).toMatchObject({ ok: false, reason: "wrong", attemptsLeft: MAX_ATTEMPTS - i });
      row = { ...row, attempts: r.nextAttempts, lockedUntil: r.nextLockedUntil };
    }
    const locked = decideAttempt(row, false, now);
    expect(locked.decision).toMatchObject({ ok: false, reason: "locked" });
    row = { ...row, attempts: locked.nextAttempts, lockedUntil: locked.nextLockedUntil };
    expect(decideAttempt(row, true, now).decision).toMatchObject({ ok: false, reason: "locked" }); // even the right code waits
    const later = new Date(now.getTime() + 16 * 60000);
    expect(decideAttempt(row, true, later).decision).toEqual({ ok: true });
  });
  it("is single use", () => {
    expect(decideAttempt({ attempts: 0, lockedUntil: null, usedAt: new Date() }, true, new Date()).decision).toMatchObject({ ok: false, reason: "used" });
  });
});
