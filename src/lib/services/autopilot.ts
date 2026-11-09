import "server-only";
import type { AgreementTerms } from "../agreement";
import { one, pool, q, tx } from "../db";
import { placeName } from "../locations";
import { formatUsd } from "../money";
import { fmtTime } from "../time";
import type { Offer, Payment, Task } from "../types";
import { approveAgreement, selectOffer } from "./agreements";
import { agentSay, logEvent, UserError } from "./common";
import { fundEscrow } from "./lifecycle";

const first = (name: string) => name.split(" ")[0];

/**
 * Worker standing instruction: if the trip allows auto-accept and the terms meet the worker's own
 * minimum fee (detour and timing are re-checked by approveAgreement), the worker's agent approves.
 */
export async function applyWorkerMandate(agreementId: string, now = new Date()): Promise<{ applied: boolean; fullyApproved: boolean }> {
  const row = await one<{ status: string; current_version: number; worker_id: string; requester_id: string; task_id: string; auto_accept: boolean; min_fee_units: number; terms: AgreementTerms; requester_name: string }>(
    `select a.status, a.current_version, a.worker_id, a.requester_id, a.task_id, tr.auto_accept, w.min_fee_units, v.terms, r.display_name as requester_name
       from agreements a join trips tr on tr.id = a.trip_id join profiles w on w.id = a.worker_id join profiles r on r.id = a.requester_id
       join agreement_versions v on v.agreement_id = a.id and v.version = a.current_version
      where a.id = $1`, [agreementId]);
  if (!row || row.status !== "pending") return { applied: false, fullyApproved: false };
  const already = await one("select 1 from agreement_approvals where agreement_id = $1 and version = $2 and profile_id = $3", [agreementId, row.current_version, row.worker_id]);
  if (already) return { applied: false, fullyApproved: false };
  const fee = Number(row.terms.feeUnits);
  const job = `${first(row.requester_name)}'s ${placeName(row.terms.storeId)} pickup → ${placeName(row.terms.deliveryZone)} for ${formatUsd(fee)}`;

  if (!row.auto_accept || fee < Number(row.min_fee_units)) {
    await agentSay(pool(), row.worker_id, row.task_id,
      `${job}, deliver by ${fmtTime(row.terms.deliveryDeadline)}. Fits your trip. Say "do it" to accept, or "no" to pass.`,
      { proposal: { kind: "approve", taskId: row.task_id, agreementId, version: row.current_version }, suggest: ["Do it", "No"] });
    return { applied: false, fullyApproved: false };
  }
  try {
    const r = await approveAgreement(agreementId, row.current_version, row.worker_id, now, "mandate");
    await q("update notifications set read_at = now() where profile_id = $1 and task_id = $2 and title = 'New job to approve' and read_at is null", [row.worker_id, row.task_id]);
    await agentSay(pool(), row.worker_id, row.task_id,
      `I accepted ${job} on your trip, because it meets your auto-accept rule (at least ${formatUsd(row.min_fee_units)}, within your detour limit). Deliver by ${fmtTime(row.terms.deliveryDeadline)}.`,
      { suggest: ["Status"] });
    return { applied: true, fullyApproved: r.fullyApproved };
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    await agentSay(pool(), row.worker_id, row.task_id, `I didn't auto-accept ${job}: ${e.message}`);
    return { applied: false, fullyApproved: false };
  }
}

/** Fund escrow only if the requester explicitly authorized at least this amount ("hire and pay"). */
export async function fundIfAuthorized(taskId: string): Promise<boolean> {
  const t = await one<Task>("select * from tasks where id = $1", [taskId]);
  if (!t || t.status !== "agreed" || !t.fund_authorized_units) return false;
  const pay = await one<Payment>("select * from payments where task_id = $1 and status not in ('cancelled') order by created_at desc limit 1", [taskId]);
  if (!pay || pay.status !== "awaiting_funding" || pay.pending_action) return false;
  if (Number(pay.amount_units) > Number(t.fund_authorized_units)) return false; // terms grew past what was authorized
  await tx((c) => logEvent(c, taskId, t.requester_id, "agent_funding",
    `Requester's agent is funding ${formatUsd(pay.amount_units)} into escrow, as the requester authorized when hiring.`));
  try {
    await fundEscrow(taskId, t.requester_id);
    return true;
  } catch (e) {
    if (e instanceof UserError) return false; // e.g. a concurrent funding claim won
    throw e;
  }
}

export interface HireResult { workerName: string; feeUnits: number; workerApproved: boolean; funded: boolean }

/** The requester's "do it": approve this offer, authorize funding for exactly its fee, let the worker's agent respond. */
export async function hire(taskId: string, requesterId: string, offerId: string, now = new Date()): Promise<HireResult> {
  const offer = await one<Offer & { worker_name: string }>(
    "select o.*, p.display_name as worker_name from offers o join profiles p on p.id = o.worker_id where o.id = $1 and o.task_id = $2", [offerId, taskId]);
  if (!offer) throw new UserError("That offer isn't available anymore.");
  const agreementId = await selectOffer(offerId, requesterId, now); // all checks: owner, freshness, budget, feasibility
  await q("update tasks set fund_authorized_units = $2 where id = $1 and requester_id = $3", [taskId, offer.fee_units, requesterId]);
  const m = await applyWorkerMandate(agreementId, now);
  const funded = m.fullyApproved ? await fundIfAuthorized(taskId) : false;
  return { workerName: first(offer.worker_name), feeUnits: Number(offer.fee_units), workerApproved: m.fullyApproved, funded };
}

/** After any approval that completes the agreement, continue with authorized funding. */
export async function afterApproval(taskId: string, fullyApproved: boolean): Promise<boolean> {
  return fullyApproved ? fundIfAuthorized(taskId) : false;
}
