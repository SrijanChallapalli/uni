import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { buildTerms, hashTerms, isFullyApproved, materialChanges, REFUND_GRACE_HOURS, type AgreementTerms } from "../agreement";
import { one, pool, q, tx } from "../db";
import { escrowIdFor } from "../escrow/abi";
import { escrowMode, getAdapter } from "../escrow/adapter";
import { hashCode, deriveCode, newSalt } from "../handoff";
import { formatUsd } from "../money";
import type { Agreement, Offer, Profile, Task } from "../types";
import { liveAgreement, lockTask, logEvent, notify, UserError } from "./common";
import { evaluateTrip } from "./matching";

async function currentVersion(c: PoolClient, ag: Agreement) {
  return one<{ terms: AgreementTerms; terms_hash: string; version: number }>(
    "select terms, terms_hash, version from agreement_versions where agreement_id = $1 and version = $2", [ag.id, ag.current_version], c);
}

/** Requester picks an offer and approves version 1 of the agreement. */
export async function selectOffer(offerId: string, requesterId: string, now = new Date()): Promise<string> {
  return tx(async (c) => {
    const offer = await one<Offer>("select * from offers where id = $1 for update", [offerId], c);
    if (!offer) throw new UserError("Offer not found.");
    const task = await lockTask(c, offer.task_id);
    if (task.requester_id !== requesterId) throw new UserError("Only the requester can accept this offer.");
    if (offer.worker_id === requesterId) throw new UserError("You can't hire yourself.");
    if (task.status !== "open") throw new UserError("This request already has an agreement in progress.");
    if (offer.status !== "proposed") throw new UserError("This offer is no longer available. Run matching again.");
    if (new Date(offer.expires_at) < now) {
      await q("update offers set status = 'expired' where id = $1", [offer.id], c);
      throw new UserError("This offer expired. Run matching again for fresh offers.");
    }
    if (offer.task_terms_version !== task.terms_version) throw new UserError("The request changed after this offer was made.");
    if (offer.decision === "reject") throw new UserError("This worker's agent declined.");
    if (offer.fee_units > task.max_fee_units) throw new UserError(`This offer (${formatUsd(offer.fee_units)}) is above your maximum fee.`);

    // Revalidate feasibility against current data (trip changes, new commitments, capacity).
    const { ev } = await evaluateTrip(c, task, offer.trip_id, now, true);
    if (!ev.feasible || !ev.estimate) {
      await q("update offers set status = 'expired' where id = $1", [offer.id], c);
      throw new UserError(`No longer feasible: ${ev.rejects[0]?.message ?? "trip changed"}`);
    }

    const terms = buildTerms({
      taskId: task.id, requesterId: task.requester_id, workerId: offer.worker_id, tripId: offer.trip_id,
      storeId: task.store_id, deliveryZone: task.delivery_zone, packageSize: task.package_size, feeUnits: offer.fee_units,
      pickupWindowStart: new Date(task.pickup_window_start).toISOString(), pickupWindowEnd: new Date(task.pickup_window_end).toISOString(),
      deliveryDeadline: new Date(task.delivery_deadline).toISOString(),
    });
    const hash = hashTerms(terms);
    const ag = await one<{ id: string }>(
      "insert into agreements (task_id, offer_id, requester_id, worker_id, trip_id) values ($1,$2,$3,$4,$5) returning id",
      [task.id, offer.id, task.requester_id, offer.worker_id, offer.trip_id], c);
    await q("insert into agreement_versions (agreement_id, version, terms, terms_hash, created_by) values ($1,1,$2,$3,$4)", [ag!.id, JSON.stringify(terms), hash, requesterId], c);
    await q("insert into agreement_approvals (agreement_id, version, profile_id, terms_hash) values ($1,1,$2,$3)", [ag!.id, requesterId, hash], c);
    await q("update offers set status = 'selected' where id = $1", [offer.id], c);
    await q("update tasks set status = 'negotiating' where id = $1", [task.id], c);
    await logEvent(c, task.id, requesterId, "agreement_proposed", `Requester approved terms v1 at ${formatUsd(offer.fee_units)} and sent them to the worker.`);
    await notify(c, [offer.worker_id], task.id, "New job to approve", `A requester approved your agent's ${offer.decision === "counter" ? "counteroffer" : "offer"} at ${formatUsd(offer.fee_units)}. Review and approve to lock it in.`);
    return ag!.id;
  });
}

/** Approve the exact current version. When both parties have approved it, revalidate and assign. */
export async function approveAgreement(agreementId: string, version: number, profileId: string, now = new Date(), via: "user" | "mandate" = "user"): Promise<{ fullyApproved: boolean }> {
  return tx(async (c) => {
    const pre = await one<Agreement>("select * from agreements where id = $1", [agreementId], c);
    if (!pre) throw new UserError("Agreement not found.");
    const task = await lockTask(c, pre.task_id); // serializes concurrent approvals/acceptances for this task
    const ag = (await one<Agreement>("select * from agreements where id = $1 for update", [agreementId], c))!;
    if (profileId !== ag.requester_id && profileId !== ag.worker_id) throw new UserError("You are not a party to this agreement.");
    if (ag.status === "approved") return { fullyApproved: true };
    if (ag.status !== "pending") throw new UserError("This agreement was cancelled.");
    if (version !== ag.current_version) throw new UserError("These terms were edited. Review the latest version before approving.");
    const cur = (await currentVersion(c, ag))!;
    await q(
      "insert into agreement_approvals (agreement_id, version, profile_id, terms_hash, via) values ($1,$2,$3,$4,$5) on conflict do nothing",
      [ag.id, version, profileId, cur.terms_hash, via], c);
    const approvals = await q<{ version: number; profile_id: string; terms_hash: string }>(
      "select version, profile_id, terms_hash from agreement_approvals where agreement_id = $1", [ag.id], c);
    const full = isFullyApproved({
      currentVersion: ag.current_version, currentHash: cur.terms_hash, requesterId: ag.requester_id, workerId: ag.worker_id,
      approvals: approvals.map((a) => ({ version: a.version, profileId: a.profile_id, termsHash: a.terms_hash })),
    });
    const who = (profileId === ag.requester_id ? "Requester" : "Worker") + (via === "mandate" ? "'s agent (standing instruction)" : "");
    if (!full) {
      await logEvent(c, task.id, profileId, "approved", `${who} approved terms v${version}.`);
      await notify(c, [profileId === ag.requester_id ? ag.worker_id : ag.requester_id], task.id, "Terms approved", `${who} approved v${version}. Your approval is needed.`);
      return { fullyApproved: false };
    }

    // Both approved the same version → revalidate feasibility with the trip locked, then assign.
    const { ev } = await evaluateTrip(c, task, ag.trip_id, now, true);
    if (!ev.feasible || !ev.estimate) throw new UserError(`Can't assign: ${ev.rejects[0]?.message ?? "no longer feasible"}`);
    const terms = cur.terms;
    try {
      await q("savepoint assign", [], c);
      await q(
        "insert into assignments (task_id, agreement_id, worker_id, trip_id, window_start, window_end) values ($1,$2,$3,$4,$5,$6)",
        [task.id, ag.id, ag.worker_id, ag.trip_id, ev.estimate.pickupAt, ev.estimate.etaDeliveryHigh], c);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        await q("rollback to savepoint assign", [], c);
        throw new UserError("That trip was just booked for another task. The requester can pick another offer.");
      }
      throw e;
    }
    await q("update agreements set status = 'approved' where id = $1", [ag.id], c);
    await q("update tasks set status = 'agreed' where id = $1", [task.id], c);

    const worker = await one<Profile>("select payout_address from profiles where id = $1", [ag.worker_id], c);
    const mode = escrowMode();
    if (mode === "arc_testnet" && !worker?.payout_address) throw new UserError("The worker needs a payout address before an on-chain escrow can be created.");
    const adapter = getAdapter();
    const paymentId = randomUUID();
    await q(
      `insert into payments (id, task_id, agreement_id, mode, amount_units, escrow_id, chain_id, contract_address, payer_address, worker_address, refund_after)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [paymentId, task.id, ag.id, mode, terms.feeUnits, escrowIdFor(paymentId), adapter.chainId, adapter.contractAddress, adapter.payerAddress,
        worker?.payout_address?.toLowerCase() ?? null, new Date(new Date(terms.deliveryDeadline).getTime() + REFUND_GRACE_HOURS * 3600_000)], c);
    const salt = newSalt();
    await q(
      `insert into handoff_codes (task_id, salt, code_hash) values ($1,$2,$3)
       on conflict (task_id) do update set salt = excluded.salt, code_hash = excluded.code_hash, attempts = 0, locked_until = null, used_at = null`,
      [task.id, salt, hashCode(task.id, deriveCode(task.id, salt))], c);
    await q("update offers set status = 'superseded' where task_id = $1 and status = 'proposed'", [task.id], c);
    await logEvent(c, task.id, profileId, "agreed", `${who} approved v${version}. Both parties approved — job assigned. Next: requester funds escrow (${formatUsd(terms.feeUnits)}).`);
    const autoFund = task.fund_authorized_units !== null && Number(terms.feeUnits) <= Number(task.fund_authorized_units);
    await notify(c, [ag.requester_id, ag.worker_id], task.id, "Agreement locked in",
      autoFund ? `Both of you approved. The requester's agent is funding ${formatUsd(terms.feeUnits)} into escrow, as the requester authorized.`
        : `Both of you approved. Requester: fund ${formatUsd(terms.feeUnits)} into escrow to start.`);
    return { fullyApproved: true };
  });
}

/** Edit material terms → new version. Previous approvals no longer count. The editor approves the new version. */
export async function editTerms(agreementId: string, profileId: string, changes: Partial<Pick<AgreementTerms, "feeUnits" | "deliveryDeadline" | "pickupWindowStart" | "pickupWindowEnd">>): Promise<number> {
  return tx(async (c) => {
    const pre = await one<Agreement>("select * from agreements where id = $1", [agreementId], c);
    if (!pre) throw new UserError("Agreement not found.");
    const task = await lockTask(c, pre.task_id);
    const ag = (await one<Agreement>("select * from agreements where id = $1 for update", [agreementId], c))!;
    if (profileId !== ag.requester_id && profileId !== ag.worker_id) throw new UserError("You are not a party to this agreement.");
    if (ag.status !== "pending") throw new UserError("Terms are locked once both parties approve.");
    const cur = (await currentVersion(c, ag))!;
    const next: AgreementTerms = { ...cur.terms, ...changes };
    if (!Number.isSafeInteger(next.feeUnits) || next.feeUnits <= 0 || next.feeUnits > 100_000_000) throw new UserError("Fee must be between $0.01 and $100.");
    if (new Date(next.pickupWindowEnd) <= new Date(next.pickupWindowStart)) throw new UserError("Pickup window must end after it starts.");
    if (new Date(next.deliveryDeadline) <= new Date(next.pickupWindowStart)) throw new UserError("Deadline must be after pickup starts.");
    const changed = materialChanges(cur.terms, next);
    if (!changed.length) throw new UserError("Nothing changed.");
    const v = ag.current_version + 1;
    const hash = hashTerms(next);
    await q("insert into agreement_versions (agreement_id, version, terms, terms_hash, created_by) values ($1,$2,$3,$4,$5)", [ag.id, v, JSON.stringify(next), hash, profileId], c);
    await q("update agreements set current_version = $2 where id = $1", [ag.id, v], c);
    await q("insert into agreement_approvals (agreement_id, version, profile_id, terms_hash) values ($1,$2,$3,$4)", [ag.id, v, profileId, hash], c);
    const who = profileId === ag.requester_id ? "Requester" : "Worker";
    await logEvent(c, task.id, profileId, "terms_edited", `${who} proposed v${v} (changed: ${changed.join(", ")}). Earlier approvals no longer count.`);
    await notify(c, [profileId === ag.requester_id ? ag.worker_id : ag.requester_id], task.id, "Terms changed", `${who} edited the agreement (v${v}). Review and approve again.`);
    return v;
  });
}

/** Either party walks away before both approvals. Task returns to open. */
export async function declineAgreement(agreementId: string, profileId: string): Promise<void> {
  await tx(async (c) => {
    const pre = await one<Agreement>("select * from agreements where id = $1", [agreementId], c);
    if (!pre) throw new UserError("Agreement not found.");
    const task: Task = await lockTask(c, pre.task_id);
    if (profileId !== pre.requester_id && profileId !== pre.worker_id) throw new UserError("You are not a party to this agreement.");
    const ag = (await one<Agreement>("select * from agreements where id = $1 for update", [agreementId], c))!;
    if (ag.status !== "pending") throw new UserError("Only pending agreements can be declined here.");
    await q("update agreements set status = 'cancelled' where id = $1", [ag.id], c);
    await q("update offers set status = 'declined' where id = $1", [ag.offer_id], c);
    await q("update tasks set status = 'open' where id = $1 and status = 'negotiating'", [task.id], c);
    const who = profileId === ag.requester_id ? "Requester" : "Worker";
    await logEvent(c, task.id, profileId, "agreement_declined", `${who} declined the proposed terms. Request is open again.`);
    await notify(c, [profileId === ag.requester_id ? ag.worker_id : ag.requester_id], task.id, "Terms declined", `${who} declined. No money moved.`);
  });
}

export async function agreementView(taskId: string) {
  const ag = await liveAgreement(pool(), taskId);
  if (!ag) return null;
  const versions = await q<{ version: number; terms: AgreementTerms; terms_hash: string; created_by: string; created_at: Date }>(
    "select * from agreement_versions where agreement_id = $1 order by version", [ag.id]);
  const approvals = await q<{ version: number; profile_id: string; approved_at: Date }>(
    "select version, profile_id, approved_at from agreement_approvals where agreement_id = $1", [ag.id]);
  return { agreement: ag, versions, approvals, current: versions.find((v) => v.version === ag.current_version)! };
}
