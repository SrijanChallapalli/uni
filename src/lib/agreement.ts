import { createHash } from "node:crypto";

export const RESOLVER_LABEL = "Detour Ops (centralized resolver operated by the app team)";
export const RESOLVE_TIMEOUT_HOURS = 72;
export const AUTO_RELEASE_HOURS = 24;
export const REFUND_GRACE_HOURS = 2;
export const REVIEW_WINDOW_HOURS = 72;

export interface AgreementTerms {
  taskId: string;
  requesterId: string;
  workerId: string;
  tripId: string;
  storeId: string;
  deliveryZone: string;
  packageSize: string;
  feeUnits: number;
  currency: "USDC";
  pickupWindowStart: string;
  pickupWindowEnd: string;
  deliveryDeadline: string;
  completionMethod: string;
  cancellationRules: string[];
  disputeResolver: string;
  timeouts: { resolveHours: number; autoReleaseHours: number; refundGraceHours: number };
}

/** Fields whose change invalidates prior approvals. */
export const MATERIAL_FIELDS = [
  "feeUnits", "pickupWindowStart", "pickupWindowEnd", "deliveryDeadline", "deliveryZone", "storeId", "packageSize", "workerId", "tripId",
] as const;

export function buildTerms(input: Omit<AgreementTerms, "currency" | "completionMethod" | "cancellationRules" | "disputeResolver" | "timeouts">): AgreementTerms {
  return {
    ...input,
    currency: "USDC",
    completionMethod:
      "Worker enters the requester's one-time handoff code at drop-off. The code confirms receipt, not package contents. " +
      "The requester then authorizes release of the fee from escrow.",
    cancellationRules: [
      "Before escrow is funded, either side may cancel at no cost.",
      "After funding and before pickup, the requester may cancel for a full refund; the worker may cancel for a full refund to the requester (recorded as a cancellation after acceptance).",
      "After pickup, cancellation goes through a dispute.",
      `If the handoff isn't confirmed within ${REFUND_GRACE_HOURS}h after the delivery deadline, the requester can reclaim the fee.`,
      `If the handoff code is verified and the requester takes no action for ${AUTO_RELEASE_HOURS}h, the fee is released to the worker.`,
    ],
    disputeResolver: RESOLVER_LABEL,
    timeouts: { resolveHours: RESOLVE_TIMEOUT_HOURS, autoReleaseHours: AUTO_RELEASE_HOURS, refundGraceHours: REFUND_GRACE_HOURS },
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashTerms(terms: AgreementTerms): string {
  return createHash("sha256").update(canonical(terms)).digest("hex");
}

export function materialChanges(a: AgreementTerms, b: AgreementTerms): string[] {
  return MATERIAL_FIELDS.filter((f) => canonical(a[f]) !== canonical(b[f]));
}

/** Both parties approved exactly the current version with matching hashes. */
export function isFullyApproved(args: {
  currentVersion: number;
  currentHash: string;
  requesterId: string;
  workerId: string;
  approvals: { version: number; profileId: string; termsHash: string }[];
}): boolean {
  const valid = args.approvals.filter((a) => a.version === args.currentVersion && a.termsHash === args.currentHash);
  return valid.some((a) => a.profileId === args.requesterId) && valid.some((a) => a.profileId === args.workerId);
}
