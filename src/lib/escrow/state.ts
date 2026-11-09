// Payment state machine. Payment status is separate from task status and changes ONLY on a
// confirmed escrow event (from QuickNode Streams, the simulated stream, or reconciliation).
// A submitted transaction only sets `pending_action`; it never changes `status`.

export type PaymentStatus = "awaiting_funding" | "funded" | "released" | "refunded" | "disputed" | "cancelled";
export type PendingAction = "fund" | "release" | "refund" | "dispute" | "resolve_worker" | "resolve_requester";
export type EscrowEventType = "Funded" | "Released" | "Refunded" | "Disputed" | "Resolved";

export interface PaymentSnapshot {
  status: PaymentStatus;
  pendingAction: PendingAction | null;
}

/** Which confirmed state each action may be requested from. */
const ACTION_FROM: Record<PendingAction, PaymentStatus[]> = {
  fund: ["awaiting_funding"],
  release: ["funded"],
  refund: ["funded"],
  dispute: ["funded"],
  resolve_worker: ["disputed"],
  resolve_requester: ["disputed"],
};

export class PaymentTransitionError extends Error {}

/** Guard for submitting a new action. Prevents double funding / double release / duplicate refunds. */
export function assertCanRequest(p: PaymentSnapshot, action: PendingAction): void {
  if (p.pendingAction) {
    throw new PaymentTransitionError(`A "${p.pendingAction}" transaction is already pending confirmation.`);
  }
  if (!ACTION_FROM[action].includes(p.status)) {
    throw new PaymentTransitionError(`Can't ${action.replace("_", " ")} while payment is ${p.status.replace("_", " ")}.`);
  }
}

export interface ConfirmedEvent {
  type: EscrowEventType;
  /** For Resolved: true if paid to worker, false if refunded to requester. */
  toWorker?: boolean;
}

export type ApplyResult =
  | { kind: "applied"; next: PaymentStatus; resolvedByResolver: boolean }
  | { kind: "duplicate" } // already in the target state: idempotent no-op
  | { kind: "invalid"; reason: string }; // out-of-order or impossible: recorded, not applied

export function targetOf(e: ConfirmedEvent): PaymentStatus {
  switch (e.type) {
    case "Funded": return "funded";
    case "Released": return "released";
    case "Refunded": return "refunded";
    case "Disputed": return "disputed";
    case "Resolved": return e.toWorker ? "released" : "refunded";
  }
}

const EVENT_FROM: Record<EscrowEventType, PaymentStatus[]> = {
  Funded: ["awaiting_funding"],
  Released: ["funded"],
  Refunded: ["funded", "disputed"],
  Disputed: ["funded"],
  Resolved: ["disputed"],
};

export function applyConfirmedEvent(current: PaymentStatus, e: ConfirmedEvent): ApplyResult {
  const next = targetOf(e);
  if (EVENT_FROM[e.type].includes(current)) {
    return { kind: "applied", next, resolvedByResolver: e.type === "Resolved" };
  }
  if (current === next) return { kind: "duplicate" };
  return { kind: "invalid", reason: `${e.type} event cannot apply to a ${current} payment` };
}

/** Whether a confirmed event clears the matching pending action. */
export function clearsPending(pending: PendingAction | null, e: ConfirmedEvent): boolean {
  if (!pending) return false;
  const map: Record<EscrowEventType, PendingAction[]> = {
    Funded: ["fund"],
    Released: ["release"],
    Refunded: ["refund", "resolve_requester"],
    Disputed: ["dispute"],
    Resolved: ["resolve_worker", "resolve_requester"],
  };
  return map[e.type].includes(pending);
}

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  awaiting_funding: "Waiting for requester to fund escrow",
  funded: "Fee held in escrow",
  released: "Paid to worker",
  refunded: "Refunded to requester",
  disputed: "Frozen — dispute open",
  cancelled: "Cancelled before funding",
};

export const PENDING_LABEL: Record<PendingAction, string> = {
  fund: "Funding submitted — waiting for on-chain confirmation",
  release: "Release submitted — waiting for confirmation",
  refund: "Refund submitted — waiting for confirmation",
  dispute: "Dispute submitted — waiting for confirmation",
  resolve_worker: "Resolution (pay worker) submitted — waiting for confirmation",
  resolve_requester: "Resolution (refund) submitted — waiting for confirmation",
};
