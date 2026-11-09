import "server-only";
import { z } from "zod";
import { RESOLVE_TIMEOUT_HOURS, RESOLVER_LABEL, REVIEW_WINDOW_HOURS } from "../agreement";
import { one, q, tx } from "../db";
import { codeMatches, decideAttempt, deriveCode } from "../handoff";
import { isStore, isZone, MODE_MAX_SIZE, SIZE_RANK } from "../locations";
import type { Mode, PackageSize } from "../locations";
import { formatUsd } from "../money";
import type { Agreement, Payment, Profile, Task, Trip } from "../types";
import { agentSay, liveAgreement, livePayment, lockTask, logEvent, notify, UserError } from "./common";
import { autoReleaseDue, submitPaymentAction } from "./payments";

// ------------------------------------------------------------------ profiles
export const profileSchema = z.object({
  display_name: z.string().trim().min(1).max(60),
  home_zone: z.string().refine(isZone, "Pick a campus area"),
  transport: z.enum(["walk", "bike", "bus", "car"]),
  capacity: z.enum(["small", "medium", "large"]),
  min_fee_units: z.number().int().min(0).max(100_000_000),
  max_detour_min: z.number().int().min(0).max(240),
  default_budget_units: z.number().int().min(0).max(100_000_000),
  default_deadline_buffer_min: z.number().int().min(0).max(1440),
  availability: z.array(z.object({ day: z.string().max(10), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })).max(21),
  payout_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).nullable(),
});

export async function saveProfile(viewer: { authUserId: string | null; profileId: string | null }, input: z.infer<typeof profileSchema>): Promise<string> {
  const v = profileSchema.parse(input);
  if (viewer.profileId) {
    await q(
      `update profiles set display_name=$2, home_zone=$3, transport=$4, capacity=$5, min_fee_units=$6, max_detour_min=$7,
         default_budget_units=$8, default_deadline_buffer_min=$9, availability=$10, payout_address=$11, onboarded=true where id=$1`,
      [viewer.profileId, v.display_name, v.home_zone, v.transport, v.capacity, v.min_fee_units, v.max_detour_min, v.default_budget_units,
        v.default_deadline_buffer_min, JSON.stringify(v.availability), v.payout_address]);
    return viewer.profileId;
  }
  if (!viewer.authUserId) throw new UserError("Sign in first.");
  const row = await one<{ id: string }>(
    `insert into profiles (auth_user_id, display_name, home_zone, transport, capacity, min_fee_units, max_detour_min, default_budget_units,
       default_deadline_buffer_min, availability, payout_address, onboarded)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true) returning id`,
    [viewer.authUserId, v.display_name, v.home_zone, v.transport, v.capacity, v.min_fee_units, v.max_detour_min, v.default_budget_units,
      v.default_deadline_buffer_min, JSON.stringify(v.availability), v.payout_address]);
  return row!.id;
}

// ------------------------------------------------------------------ trips
export const tripSchema = z.object({
  origin_zone: z.string().refine(isZone, "Pick where you start"),
  store_id: z.string().refine(isStore, "Pick a store"),
  return_zone: z.string().refine(isZone, "Pick where you return"),
  depart_at: z.date(),
  return_by: z.date(),
  transport: z.enum(["walk", "bike", "bus", "car"]),
  capacity: z.enum(["small", "medium", "large"]),
  notes: z.string().max(280).nullable(),
  /** Standing instruction: the worker's agent may approve jobs on this trip that meet their minimum fee and detour limits. */
  auto_accept: z.boolean().optional(),
});

export async function createTrip(workerId: string, input: z.infer<typeof tripSchema>, now = new Date()): Promise<string> {
  const v = tripSchema.parse(input);
  if (v.return_by <= v.depart_at) throw new UserError("Return time must be after departure.");
  if (v.depart_at.getTime() < now.getTime() - 5 * 60000) throw new UserError("Departure is in the past.");
  if (SIZE_RANK[v.capacity as PackageSize] > SIZE_RANK[MODE_MAX_SIZE[v.transport as Mode]]) throw new UserError(`A ${v.capacity} package isn't realistic by ${v.transport}.`);
  const row = await one<{ id: string }>(
    `insert into trips (worker_id, origin_zone, store_id, return_zone, depart_at, return_by, transport, capacity, notes, auto_accept)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [workerId, v.origin_zone, v.store_id, v.return_zone, v.depart_at, v.return_by, v.transport, v.capacity, v.notes, v.auto_accept ?? false]);
  return row!.id;
}

export async function cancelTrip(workerId: string, tripId: string): Promise<void> {
  await tx(async (c) => {
    const trip = await one<Trip>("select * from trips where id = $1 for update", [tripId], c);
    if (!trip || trip.worker_id !== workerId) throw new UserError("Trip not found.");
    const busy = await one("select 1 from assignments where trip_id = $1 and active", [tripId], c);
    if (busy) throw new UserError("This trip has an assigned task. Cancel the task first.");
    await q("update trips set status = 'cancelled' where id = $1", [tripId], c);
    await q("update offers set status = 'expired' where trip_id = $1 and status = 'proposed'", [tripId], c);
  });
}

// ------------------------------------------------------------------ tasks
export const taskSchema = z.object({
  store_id: z.string().refine(isStore, "Pick a store"),
  delivery_zone: z.string().refine(isZone, "Pick a delivery area"),
  delivery_detail: z.string().max(200).nullable(),
  order_reference: z.string().max(80).nullable(),
  pickup_window_start: z.date(),
  pickup_window_end: z.date(),
  delivery_deadline: z.date(),
  package_size: z.enum(["small", "medium", "large"]),
  prepaid_confirmed: z.literal(true, { message: "Only prepaid orders are supported — confirm the order is paid." }),
  offered_fee_units: z.number().int().min(10_000, "Fee must be at least $0.01").max(100_000_000),
  max_fee_units: z.number().int().min(10_000).max(100_000_000),
  instructions: z.string().max(500).nullable(),
  raw_text: z.string().max(1000).nullable(),
});

export async function createTask(requesterId: string, input: z.infer<typeof taskSchema>, now = new Date()): Promise<string> {
  const v = taskSchema.parse(input);
  if (v.pickup_window_end <= v.pickup_window_start) throw new UserError("Pickup window must end after it starts.");
  if (v.delivery_deadline <= v.pickup_window_start) throw new UserError("Deadline must be after the pickup window opens.");
  if (v.delivery_deadline.getTime() < now.getTime()) throw new UserError("Deadline is in the past.");
  if (v.max_fee_units < v.offered_fee_units) throw new UserError("Max fee must be at least your offered fee.");
  return tx(async (c) => {
    const row = await one<{ id: string }>(
      `insert into tasks (requester_id, store_id, delivery_zone, delivery_detail, order_reference, pickup_window_start, pickup_window_end,
         delivery_deadline, package_size, prepaid_confirmed, offered_fee_units, max_fee_units, instructions, raw_text)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [requesterId, v.store_id, v.delivery_zone, v.delivery_detail, v.order_reference, v.pickup_window_start, v.pickup_window_end,
        v.delivery_deadline, v.package_size, true, v.offered_fee_units, v.max_fee_units, v.instructions, v.raw_text], c);
    await logEvent(c, row!.id, requesterId, "created", `Request posted with an opening offer of ${formatUsd(v.offered_fee_units)}.`);
    return row!.id;
  });
}

// ------------------------------------------------------------------ execution
async function assigned(taskId: string, profileId: string, role: "worker" | "requester" | "either") {
  const task = await one<Task>("select * from tasks where id = $1", [taskId]);
  if (!task) throw new UserError("Task not found.");
  const ag = await one<Agreement>("select * from agreements where task_id = $1 and status = 'approved'", [taskId]);
  if (!ag) throw new UserError("This task has no approved agreement.");
  const isReq = ag.requester_id === profileId;
  const isWorker = ag.worker_id === profileId;
  if ((role === "worker" && !isWorker) || (role === "requester" && !isReq) || (role === "either" && !isReq && !isWorker)) {
    throw new UserError("You aren't allowed to do that on this task.");
  }
  return { task, ag, isReq, isWorker };
}

export async function fundEscrow(taskId: string, profileId: string) {
  const { task } = await assigned(taskId, profileId, "requester");
  if (task.status !== "agreed") throw new UserError("Escrow can only be funded after both parties approve.");
  return submitPaymentAction(taskId, "fund", profileId);
}

export async function markPickedUp(taskId: string, workerId: string) {
  await tx(async (c) => {
    const task = await lockTask(c, taskId);
    const ag = await liveAgreement(c, taskId);
    if (!ag || ag.status !== "approved" || ag.worker_id !== workerId) throw new UserError("Only the assigned worker can do that.");
    const pay = await livePayment(c, taskId);
    if (task.status !== "agreed") throw new UserError("Task isn't ready for pickup.");
    if (pay?.status !== "funded") throw new UserError("Wait until the fee is confirmed in escrow before picking up.");
    await q("update tasks set status = 'picked_up' where id = $1", [taskId], c);
    await logEvent(c, taskId, workerId, "picked_up", "Worker picked up the order.");
    await notify(c, [ag.requester_id], taskId, "Order picked up", "Your order is on the way. Have your handoff code ready.");
    const hc = await one<{ salt: string }>("select salt from handoff_codes where task_id = $1", [taskId], c);
    await agentSay(c, ag.requester_id, taskId, `Your order was picked up and is on the way.${hc ? ` When it arrives, give the worker this handoff code: ${deriveCode(taskId, hc.salt)}.` : ""}`, { suggest: ["Status"] });
  });
}

/** Server-side verification of the one-time handoff code with rate limiting. */
export async function verifyHandoff(taskId: string, workerId: string, input: string, now = new Date()): Promise<{ ok: boolean; message: string }> {
  return tx(async (c) => {
    const task = await lockTask(c, taskId);
    const ag = await liveAgreement(c, taskId);
    if (!ag || ag.status !== "approved" || ag.worker_id !== workerId) throw new UserError("Only the assigned worker can submit the code.");
    if (task.status !== "picked_up") throw new UserError("Mark the order as picked up first.");
    const row = await one<{ code_hash: string; attempts: number; locked_until: Date | null; used_at: Date | null }>(
      "select * from handoff_codes where task_id = $1 for update", [taskId], c);
    if (!row) throw new UserError("No handoff code exists for this task.");
    const matches = codeMatches(taskId, input, row.code_hash);
    const { decision, nextAttempts, nextLockedUntil } = decideAttempt(
      { attempts: row.attempts, lockedUntil: row.locked_until ? new Date(row.locked_until) : null, usedAt: row.used_at ? new Date(row.used_at) : null }, matches, now);
    if (!decision.ok) {
      await q("update handoff_codes set attempts = $2, locked_until = $3 where task_id = $1", [taskId, nextAttempts, nextLockedUntil], c);
      const msg = decision.reason === "used" ? "This code was already used."
        : decision.reason === "locked" ? `Too many wrong attempts. Try again after ${new Date(decision.lockedUntil!).toLocaleTimeString("en-US", { timeZone: "America/Indiana/Indianapolis" })}.`
        : `That code doesn't match. ${decision.attemptsLeft} attempt(s) left.`;
      if (decision.reason !== "used") await logEvent(c, taskId, workerId, "handoff_code_rejected", "A handoff code attempt failed.");
      return { ok: false, message: msg };
    }
    await q("update handoff_codes set used_at = $2, attempts = $3 where task_id = $1", [taskId, now, nextAttempts], c);
    await q("update tasks set status = 'handed_off' where id = $1", [taskId], c);
    await q("update payments set release_due_at = $2 where task_id = $1 and status = 'funded'", [taskId, new Date(now.getTime() + 24 * 3600_000)], c);
    await logEvent(c, taskId, workerId, "handed_off", "Handoff code verified. This confirms the requester received a package — not its contents.");
    await notify(c, [ag.requester_id], taskId, "Handoff confirmed", "Check your order, then confirm to release payment (auto-releases in 24h).");
    await agentSay(c, ag.requester_id, taskId, `The worker entered your handoff code. Check the bag. If it's all there, say "got it" and I'll release the payment. If something's wrong, describe it and I'll open a dispute.`,
      { proposal: { kind: "release", taskId }, suggest: ["Got it", "Something's missing"] });
    return { ok: true, message: "Code verified. The requester will confirm and release payment." };
  });
}

export function handoffCodeFor(taskId: string, salt: string) {
  return deriveCode(taskId, salt);
}

export async function authorizeRelease(taskId: string, requesterId: string) {
  const { task } = await assigned(taskId, requesterId, "requester");
  if (task.status !== "handed_off") throw new UserError("Payment can be released after the worker verifies your handoff code.");
  await tx(async (c) => logEvent(c, taskId, requesterId, "release_authorized", "Requester confirmed receipt and authorized release."));
  return submitPaymentAction(taskId, "release", requesterId);
}

export async function cancelTask(taskId: string, profileId: string): Promise<string> {
  const task = await one<Task>("select * from tasks where id = $1", [taskId]);
  if (!task) throw new UserError("Task not found.");
  const ag = await one<Agreement>("select * from agreements where task_id = $1 and status in ('pending','approved') order by created_at desc limit 1", [taskId]);
  const isReq = task.requester_id === profileId;
  const isWorker = ag?.worker_id === profileId;
  if (!isReq && !isWorker) throw new UserError("You can't cancel this task.");
  if (["picked_up", "handed_off"].includes(task.status)) throw new UserError("After pickup, cancellation goes through a dispute.");
  if (["completed", "cancelled", "disputed"].includes(task.status)) throw new UserError("This task can't be cancelled now.");

  const pay = await one<Payment>("select * from payments where task_id = $1 and status not in ('cancelled','refunded') order by created_at desc limit 1", [taskId]);
  if (pay?.status === "funded") {
    // After funding, before pickup: refund the requester through escrow.
    await tx(async (c) => {
      if (isWorker) await logEvent(c, taskId, profileId, "cancelled_after_acceptance", "Worker cancelled after accepting. Fee will be refunded to the requester.");
      else await logEvent(c, taskId, profileId, "requester_cancelled", "Requester cancelled after funding. Fee will be refunded.");
    });
    await submitPaymentAction(taskId, "refund", profileId, { refundReason: isWorker ? "worker_cancel" : "requester_cancel" });
    return "Refund submitted.";
  }
  if (pay && (pay.status !== "awaiting_funding" || pay.pending_action)) throw new UserError("A payment action is in progress; try again shortly.");

  await tx(async (c) => {
    await lockTask(c, taskId);
    if (pay) await q("update payments set status = 'cancelled', updated_at = now() where id = $1", [pay.id], c);
    await q("update assignments set active = false where task_id = $1 and active", [taskId], c);
    if (ag) await q("update agreements set status = 'cancelled' where id = $1", [ag.id], c);
    await q("update offers set status = 'expired' where task_id = $1 and status in ('proposed','selected')", [taskId], c);
    if (isReq) {
      await q("update tasks set status = 'cancelled' where id = $1", [taskId], c);
      await logEvent(c, taskId, profileId, "cancelled", "Requester cancelled the request. No money moved.");
      await notify(c, [ag?.worker_id], taskId, "Request cancelled", "The requester cancelled before funding. No money moved.");
    } else {
      await q("update tasks set status = 'open' where id = $1", [taskId], c);
      const afterAccept = ag?.status === "approved";
      await logEvent(c, taskId, profileId, afterAccept ? "cancelled_after_acceptance" : "worker_withdrew",
        afterAccept ? "Worker cancelled after accepting. Request reopened." : "Worker withdrew before approving. Request reopened.");
      await notify(c, [task.requester_id], taskId, "Worker cancelled", "Your request is open again — run matching for another worker.");
    }
  });
  return "Cancelled.";
}

// ------------------------------------------------------------------ disputes
export async function openDispute(taskId: string, profileId: string, reason: string) {
  const { task, ag } = await assigned(taskId, profileId, "either");
  if (!["agreed", "picked_up", "handed_off"].includes(task.status)) throw new UserError("Disputes can be opened while the fee is held in escrow.");
  const r = reason.trim();
  if (r.length < 5) throw new UserError("Describe the problem in a few words.");
  await tx(async (c) => {
    const pay = await livePayment(c, taskId, true);
    if (pay?.status !== "funded" || pay.pending_action) throw new UserError("Disputes can only be opened while the fee is held in escrow.");
    try {
      await q("insert into disputes (task_id, opened_by, reason, resolver_label, respond_by) values ($1,$2,$3,$4,$5)",
        [taskId, profileId, r.slice(0, 1000), RESOLVER_LABEL, new Date(Date.now() + RESOLVE_TIMEOUT_HOURS * 3600_000)], c);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new UserError("A dispute is already open.");
      throw e;
    }
    await logEvent(c, taskId, profileId, "dispute_opened", `${profileId === ag.requester_id ? "Requester" : "Worker"} opened a dispute. Opening a dispute does not penalize either side.`);
  });
  try {
    await submitPaymentAction(taskId, "dispute", profileId, { refundReason: "dispute" });
  } catch (e) {
    await q("delete from disputes where task_id = $1 and status = 'open'", [taskId]);
    throw e;
  }
}

export async function resolveDispute(taskId: string, resolverId: string, toWorker: boolean, note: string) {
  const resolver = await one<Profile>("select * from profiles where id = $1", [resolverId]);
  if (!resolver?.is_resolver) throw new UserError("Only the disclosed resolver can resolve disputes.");
  const d = await one<{ id: string }>("select id from disputes where task_id = $1 and status = 'open'", [taskId]);
  if (!d) throw new UserError("No open dispute.");
  await q("update disputes set resolution_note = $2 where id = $1", [d.id, note.slice(0, 1000)]);
  await submitPaymentAction(taskId, toWorker ? "resolve_worker" : "resolve_requester", resolverId);
}

// ------------------------------------------------------------------ reviews
export async function submitReview(taskId: string, reviewerId: string, rating: number, comment: string | null) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new UserError("Rating must be 1–5.");
  const task = await one<Task>("select * from tasks where id = $1", [taskId]);
  if (!task || task.status !== "completed") throw new UserError("Reviews open after a task is completed.");
  if (task.completed_at && Date.now() - new Date(task.completed_at).getTime() > REVIEW_WINDOW_HOURS * 3600_000) throw new UserError("The review window has closed.");
  const ag = await one<Agreement>("select * from agreements where task_id = $1 and status = 'approved'", [taskId]);
  if (!ag) throw new UserError("No completed agreement.");
  let reviewee: string, role: "worker" | "requester";
  if (reviewerId === ag.requester_id) { reviewee = ag.worker_id; role = "worker"; }
  else if (reviewerId === ag.worker_id) { reviewee = ag.requester_id; role = "requester"; }
  else throw new UserError("Only the two people on this task can review each other.");
  try {
    await q("insert into reviews (task_id, reviewer_id, reviewee_id, reviewee_role, rating, comment) values ($1,$2,$3,$4,$5,$6)",
      [taskId, reviewerId, reviewee, role, rating, comment?.slice(0, 500) || null]);
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new UserError("You already reviewed this task.");
    throw e;
  }
}

// ------------------------------------------------------------------ timeouts (lazy sweep + cron endpoint)
export async function runTimeouts(now = new Date()): Promise<string[]> {
  const done: string[] = [];
  const due = await q<{ task_id: string; release_due_at: Date }>(
    `select p.task_id, p.release_due_at from payments p join tasks t on t.id = p.task_id
     where p.status = 'funded' and p.pending_action is null and t.status = 'handed_off' and p.release_due_at is not null and p.release_due_at <= $1`, [now]);
  for (const d of due) {
    if (!autoReleaseDue(new Date(new Date(d.release_due_at).getTime() - 24 * 3600_000), now)) continue;
    await tx(async (c) => logEvent(c, d.task_id, null, "auto_release", "Requester didn't respond within 24h of a verified handoff; releasing per the agreement."));
    await submitPaymentAction(d.task_id, "release", null).catch(() => {});
    done.push(`auto-released ${d.task_id}`);
  }
  const stale = await q<{ task_id: string }>("select task_id from disputes where status = 'open' and respond_by <= $1", [now]);
  for (const s of stale) {
    await tx(async (c) => logEvent(c, s.task_id, null, "dispute_timeout", "Resolver did not act within 72h; refunding the requester per the timeout fallback."));
    await submitPaymentAction(s.task_id, "resolve_requester", null).catch(() => {});
    done.push(`dispute timeout ${s.task_id}`);
  }
  return done;
}
