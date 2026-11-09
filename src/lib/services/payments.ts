import "server-only";
import type { Hex } from "viem";
import { AUTO_RELEASE_HOURS } from "../agreement";
import { one, q, tx, type Db } from "../db";
import { decodeEscrowLog, type DecodedEscrowEvent } from "../escrow/abi";
import { arcAdapter, getAdapter, simulatedAdapter, type EscrowAdapter } from "../escrow/adapter";
import { applyConfirmedEvent, assertCanRequest, clearsPending, PaymentTransitionError, type PendingAction } from "../escrow/state";
import { formatUsd } from "../money";
import { extractLogs } from "../streams/payload";
import type { Payment, Task } from "../types";
import { agentSay, logEvent, notify, UserError } from "./common";

type RefundReason = "requester_cancel" | "worker_cancel" | "deadline" | "dispute";

let simBlock = 1_000_000;

/**
 * Submit an escrow action. Sets pending_action (submitted ≠ confirmed). In simulated mode the
 * matching confirmed event is then delivered through the same ingestion path as QuickNode Streams.
 */
export async function submitPaymentAction(taskId: string, action: PendingAction, actorId: string | null, opts: { refundReason?: RefundReason; adapter?: EscrowAdapter } = {}): Promise<Payment> {
  // Phase 1: claim the action atomically so concurrent clicks can't double-submit.
  const p = await tx(async (c) => {
    const pay = await one<Payment>(
      "select * from payments where task_id = $1 and status not in ('cancelled') order by created_at desc limit 1 for update", [taskId], c);
    if (!pay) throw new UserError("No payment exists for this task yet.");
    try {
      assertCanRequest({ status: pay.status, pendingAction: pay.pending_action }, action);
    } catch (e) {
      if (e instanceof PaymentTransitionError) throw new UserError(e.message);
      throw e;
    }
    await q("update payments set pending_action = $2, pending_since = now(), refund_reason = coalesce($3, refund_reason), updated_at = now() where id = $1",
      [pay.id, action, opts.refundReason ?? null], c);
    return pay;
  });

  // Each payment keeps the mode it was created with (a simulated payment never touches a chain).
  const adapter = opts.adapter ?? (p.mode === "simulated" ? simulatedAdapter() : arcAdapter());

  // Phase 2: submit the transaction (outside the DB transaction; may take seconds on-chain).
  let txHash: string;
  try {
    const id = p.escrow_id as Hex;
    const r = action === "fund"
      ? await adapter.fund({ escrowId: id, worker: p.worker_address ?? "0x0000000000000000000000000000000000000001", amountUnits: p.amount_units, refundAfter: new Date(p.refund_after!) })
      : action === "release" ? await adapter.release(id)
      : action === "refund" ? await adapter.refund(id)
      : action === "dispute" ? await adapter.dispute(id)
      : await adapter.resolve(id, action === "resolve_worker");
    txHash = r.txHash;
  } catch (e) {
    await q("update payments set pending_action = null, pending_since = null, updated_at = now() where id = $1 and pending_action = $2", [p.id, action]);
    console.error("[escrow] submit failed", e);
    throw new UserError(`Couldn't submit the ${action} transaction. Nothing was charged. (${(e as Error).message.slice(0, 120)})`);
  }
  await tx(async (c) => {
    await q("update payments set pending_tx = $2, updated_at = now() where id = $1", [p.id, txHash], c);
    await logEvent(c, taskId, actorId, `payment_${action}_submitted`, `${action[0].toUpperCase()}${action.slice(1).replace("_", " ")} transaction submitted${adapter.mode === "simulated" ? " (simulated)" : ""}. Waiting for confirmation.`, { txHash });
  });

  if (adapter.mode === "simulated") {
    const type = action === "fund" ? "Funded" : action === "release" ? "Released" : action === "refund" ? "Refunded" : action === "dispute" ? "Disputed" : "Resolved";
    await processEscrowEvent({
      type, escrowId: p.escrow_id, amount: p.amount_units, toWorker: action === "resolve_worker" ? true : action === "resolve_requester" ? false : undefined,
      txHash, logIndex: 0, blockNumber: ++simBlock, blockHash: null, contract: "simulated", removed: false,
    }, "simulated_stream");
  }
  return (await one<Payment>("select * from payments where id = $1", [p.id]))!;
}

export type ProcessOutcome = "applied" | "duplicate" | "ignored" | "invalid";

/** Idempotent ingestion of one confirmed escrow event (Streams, simulated stream, or reconciliation). */
export async function processEscrowEvent(ev: DecodedEscrowEvent, source: "quicknode_stream" | "simulated_stream" | "reconcile"): Promise<ProcessOutcome> {
  const dedupe = `${ev.contract}:${ev.txHash}:${ev.logIndex}`;
  return tx(async (c) => {
    const ins = await one<{ id: number }>(
      `insert into payment_events (source, event_type, dedupe_key, tx_hash, block_number, block_hash, log_index, applied, payload)
       values ($1,$2,$3,$4,$5,$6,$7,false,$8) on conflict (dedupe_key) do nothing returning id`,
      [source, ev.type, dedupe, ev.txHash, ev.blockNumber, ev.blockHash, ev.logIndex, JSON.stringify(ev)], c);
    if (!ins) return "duplicate";
    const note = (n: string) => q("update payment_events set note = $2 where id = $1", [ins.id, n], c);
    if (ev.removed) { await note("log removed by reorg; not applied — reconciliation will re-read"); return "ignored"; }

    const pay = await one<Payment>("select * from payments where lower(escrow_id) = lower($1) for update", [ev.escrowId], c);
    if (!pay) { await note("unknown escrow id"); return "ignored"; }
    await q("update payment_events set payment_id = $2 where id = $1", [ins.id, pay.id], c);
    if (pay.contract_address && ev.contract !== "simulated" && pay.contract_address !== ev.contract) { await note("contract mismatch"); return "invalid"; }
    if (ev.type === "Funded" && ev.amount !== null && ev.amount !== pay.amount_units) { await note(`amount mismatch: ${ev.amount} != ${pay.amount_units}`); return "invalid"; }
    if (ev.type === "Funded" && ev.worker && pay.worker_address && ev.worker !== pay.worker_address) { await note("worker address mismatch"); return "invalid"; }

    const r = applyConfirmedEvent(pay.status, { type: ev.type, toWorker: ev.toWorker });
    if (r.kind === "duplicate") { await note("already in target state"); return "duplicate"; }
    if (r.kind === "invalid") { await note(r.reason); return "invalid"; }

    const clear = clearsPending(pay.pending_action, { type: ev.type, toWorker: ev.toWorker });
    const txCol = ev.type === "Funded" ? "fund_tx" : r.next === "released" ? "release_tx" : r.next === "refunded" ? "refund_tx" : null;
    await q(
      `update payments set status = $2, resolved_by_resolver = resolved_by_resolver or $3,
         pending_action = case when $4 then null else pending_action end,
         pending_tx = case when $4 then null else pending_tx end,
         pending_since = case when $4 then null else pending_since end,
         ${txCol ? `${txCol} = $5,` : ""} updated_at = now() where id = $1`,
      txCol ? [pay.id, r.next, r.resolvedByResolver, clear, ev.txHash] : [pay.id, r.next, r.resolvedByResolver, clear], c);
    await q("update payment_events set applied = true where id = $1", [ins.id], c);
    await applyTaskSideEffects(c, pay, ev, r.next, source);
    return "applied";
  });
}

async function applyTaskSideEffects(c: Db, pay: Payment, ev: DecodedEscrowEvent, next: string, source: string) {
  const task = (await one<Task>("select * from tasks where id = $1 for update", [pay.task_id], c))!;
  const ag = await one<{ requester_id: string; worker_id: string }>("select requester_id, worker_id from agreements where id = $1", [pay.agreement_id], c);
  const parties = [ag?.requester_id, ag?.worker_id];
  const via = source === "quicknode_stream" ? "QuickNode Stream" : source === "reconcile" ? "chain reconciliation" : "simulated stream";
  const amt = formatUsd(pay.amount_units);
  if (ev.type === "Funded") {
    await logEvent(c, task.id, null, "payment_funded", `Escrow funded with ${amt} (confirmed via ${via}).`, { txHash: ev.txHash });
    await notify(c, parties, task.id, "Escrow funded", `${amt} is held in escrow. Worker: you're clear to pick up.`);
    await agentSay(c, ag?.worker_id, task.id, `${amt} is locked in escrow for your pickup. Head to the store, then tell me "picked up".`, { suggest: ["Picked up", "Status"] });
  } else if (ev.type === "Disputed") {
    await q("update tasks set status = 'disputed' where id = $1", [task.id], c);
    await logEvent(c, task.id, null, "payment_disputed", `Escrow frozen for dispute (confirmed via ${via}).`, { txHash: ev.txHash });
    await notify(c, parties, task.id, "Payment frozen", "A dispute is open. The resolver will decide within 72h.");
  } else if (next === "released") {
    await q("update tasks set status = 'completed', completed_at = now() where id = $1", [task.id], c);
    if (ev.type === "Resolved") await q("update disputes set status = 'resolved_worker', resolved_at = now() where task_id = $1 and status = 'open'", [task.id], c);
    await logEvent(c, task.id, null, "payment_released", `${amt} released to the worker (confirmed via ${via}).`, { txHash: ev.txHash });
    await notify(c, parties, task.id, "Payment released", `${amt} paid to the worker. Leave a review!`);
    await agentSay(c, ag?.worker_id, task.id, `You were paid ${amt}. How was the requester? Say something like "5 stars".`, { pending: { kind: "review", taskId: task.id }, suggest: ["5 stars", "4 stars"] });
    await agentSay(c, ag?.requester_id, task.id, `Paid ${amt} to the worker. Want to rate them? Say something like "5 stars, super fast".`, { pending: { kind: "review", taskId: task.id }, suggest: ["5 stars", "4 stars"] });
  } else if (next === "refunded") {
    const reopen = pay.refund_reason === "worker_cancel";
    await q("update assignments set active = false where task_id = $1 and active", [task.id], c);
    await q("update agreements set status = 'cancelled' where id = $1", [pay.agreement_id], c);
    if (ev.type === "Resolved") {
      await q("update disputes set status = case when respond_by < now() then 'timed_out' else 'resolved_requester' end, resolved_at = now() where task_id = $1 and status = 'open'", [task.id], c);
    }
    await q("update tasks set status = $2 where id = $1", [task.id, reopen ? "open" : "cancelled"], c);
    await logEvent(c, task.id, null, "payment_refunded", `${amt} refunded to the requester (confirmed via ${via}).${reopen ? " Request reopened for matching." : ""}`, { txHash: ev.txHash });
    await notify(c, parties, task.id, "Refund confirmed", `${amt} returned to the requester.`);
    await agentSay(c, ag?.requester_id, task.id, `${amt} came back to you from escrow.${reopen ? " Your request is open again. Say \"search again\" to find someone else." : ""}`);
  }
}

/** Verified QuickNode Streams (or simulated) payload → events → idempotent processing. */
export async function ingestStreamPayload(payload: unknown, source: "quicknode_stream" | "simulated_stream"): Promise<Record<ProcessOutcome, number>> {
  const contract = process.env.ESCROW_CONTRACT_ADDRESS;
  const counts: Record<ProcessOutcome, number> = { applied: 0, duplicate: 0, ignored: 0, invalid: 0 };
  if (!contract) return counts;
  for (const log of extractLogs(payload, contract)) {
    const ev = decodeEscrowLog(log);
    if (!ev) { counts.ignored++; continue; }
    counts[await processEscrowEvent(ev, source)]++;
  }
  return counts;
}

/** Recovery: re-read confirmed logs from the chain since the last cursor and process any the stream missed. */
export async function reconcile(adapter: EscrowAdapter = getAdapter()): Promise<{ scanned: string; outcomes: Record<ProcessOutcome, number> }> {
  const outcomes: Record<ProcessOutcome, number> = { applied: 0, duplicate: 0, ignored: 0, invalid: 0 };
  if (!adapter.fetchEvents) return { scanned: "simulated mode: nothing to reconcile", outcomes };
  const cur = await one<{ last_block: number }>("select last_block from chain_cursor where id = 'escrow'");
  const deployBlock = Number(process.env.ESCROW_DEPLOY_BLOCK || 0);
  // Re-scan a few blocks behind the cursor; dedupe keys make overlap harmless.
  const from = BigInt(Math.max(deployBlock, (cur?.last_block ?? deployBlock) - 10));
  const { events, toBlock } = await adapter.fetchEvents(from, undefined);
  for (const ev of events) outcomes[await processEscrowEvent(ev, "reconcile")]++;
  await q("insert into chain_cursor (id, last_block) values ('escrow', $1) on conflict (id) do update set last_block = excluded.last_block, updated_at = now()", [Number(toBlock)]);
  return { scanned: `blocks up to ${toBlock}`, outcomes };
}

export function autoReleaseDue(handoffAt: Date, now = new Date()): boolean {
  return now.getTime() - handoffAt.getTime() >= AUTO_RELEASE_HOURS * 3600_000;
}
