import "server-only";
import { classify, parseTripCommand, type Intent } from "../agents/assistant";
import { parseRequest } from "../agents/requester";
import { one, pool, q } from "../db";
import { deriveCode } from "../handoff";
import { placeName } from "../locations";
import { dollarsToUnits, formatUsd } from "../money";
import { fmtDateTime, fmtTime, fromCampusLocal } from "../time";
import type { Agreement, Offer, Payment, Profile, Task } from "../types";
import { approveAgreement, declineAgreement } from "./agreements";
import { afterApproval, hire } from "./autopilot";
import { agentSay, type AgentMessageData, UserError } from "./common";
import {
  authorizeRelease, cancelTask, createTask, createTrip, markPickedUp, openDispute, submitReview, verifyHandoff,
} from "./lifecycle";
import { runMatching } from "./matching";

const PROPOSAL_TTL_MS = 2 * 3600_000;
const first = (n: string) => n.split(" ")[0];
const ACTIVE = "('open','negotiating','agreed','picked_up','handed_off','disputed')";

interface Reply { body: string; data?: AgentMessageData; taskId?: string | null }

export interface AgentMessage { id: number; role: "user" | "agent"; body: string; data: AgentMessageData; task_id: string | null; created_at: Date }

export async function agentThread(profileId: string, limit = 14): Promise<AgentMessage[]> {
  const rows = await q<AgentMessage>("select * from agent_messages where profile_id = $1 order by id desc limit $2", [profileId, limit]);
  return rows.reverse();
}

/** One instruction from the person to their own agent. Every action runs through the normal checked services. */
export async function handleAgentMessage(me: Profile, text: string, contextTaskId: string | null, now = new Date()): Promise<void> {
  const clean = text.trim().slice(0, 1000);
  if (!clean) throw new UserError("Tell your agent what to do.");
  const last = await one<AgentMessage>("select * from agent_messages where profile_id = $1 and role = 'agent' order by id desc limit 1", [me.id]);
  await q("insert into agent_messages (profile_id, task_id, role, body) values ($1,$2,'user',$3)", [me.id, contextTaskId, clean]);
  const fresh = last && now.getTime() - new Date(last.created_at).getTime() < PROPOSAL_TTL_MS;
  const pending = fresh ? last.data.pending : undefined;
  const proposal = fresh ? last.data.proposal : undefined;

  let reply: Reply;
  try {
    const intent = await classify(clean, pending?.kind);
    reply = await execute(me, intent, { text: clean, contextTaskId, pending, proposal, now });
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    reply = { body: `I couldn't do that: ${e.message}`, data: { suggest: ["Status"] } };
  }
  // An empty reply means the action's own event already told the person (e.g. "Paid $5 … rate them?").
  if (reply.body) await agentSay(pool(), me.id, reply.taskId ?? contextTaskId, reply.body, reply.data);
}

interface Ctx { text: string; contextTaskId: string | null; pending: AgentMessageData["pending"]; proposal: AgentMessageData["proposal"]; now: Date }

async function execute(me: Profile, intent: Intent, ctx: Ctx): Promise<Reply> {
  switch (intent.kind) {
    case "help": return help();
    case "status": return status(me);
    case "request": return request(me, ctx.pending?.kind === "request" && ctx.pending.text ? `${ctx.pending.text}. ${intent.text}` : intent.text, ctx.now);
    case "post_trip": return postTrip(me, ctx.pending?.kind === "trip" && ctx.pending.text ? `${ctx.pending.text}. ${intent.text}` : intent.text, ctx.now);
    case "confirm": return confirm(me, ctx);
    case "decline": return decline(me, ctx);
    case "hire": return hireByName(me, intent.name, ctx);
    case "rematch": {
      const task = await myOpenRequest(me, ctx.contextTaskId);
      if (!task) return { body: "You don't have an open request to search for. Tell me what you need picked up." };
      return matchAndPropose(task, me);
    }
    case "picked_up": {
      const job = await myJob(me, ["agreed"], ctx.contextTaskId);
      if (!job) return { body: "You don't have a job waiting for pickup." };
      await markPickedUp(job.id, me.id);
      return { body: `Marked as picked up. I told the requester you're on the way. When you hand it over, ask them for their 6-digit code and tell it to me.`, taskId: job.id, data: { suggest: ["Status"] } };
    }
    case "handoff_code": {
      let job = await myJob(me, ["picked_up"], ctx.contextTaskId);
      if (!job) {
        const ready = await myJob(me, ["agreed"], ctx.contextTaskId);
        if (ready) { await markPickedUp(ready.id, me.id); job = ready; }
      }
      if (!job) return { body: "You don't have a delivery in progress to enter a code for." };
      const r = await verifyHandoff(job.id, me.id, intent.code);
      return r.ok
        ? { body: "Code checks out. Handoff confirmed. The requester confirms receipt, then you get paid (or it auto-releases in 24h).", taskId: job.id }
        : { body: r.message, taskId: job.id };
    }
    case "release": {
      if (ctx.proposal?.kind === "release") return releaseTask(me, ctx.proposal.taskId);
      const t = await myRequest(me, ["handed_off"], ctx.contextTaskId);
      if (!t) return { body: "Nothing is waiting for your confirmation right now." };
      return releaseTask(me, t.id);
    }
    case "review": {
      const taskId = ctx.pending?.kind === "review" && ctx.pending.taskId ? ctx.pending.taskId : (await reviewable(me))?.id;
      if (!taskId) return { body: "There's no finished job to review." };
      if (intent.rating === null) return { body: "How many stars, 1 to 5?", data: { pending: { kind: "review", taskId }, suggest: ["5 stars", "4 stars", "3 stars"] } };
      await submitReview(taskId, me.id, intent.rating, intent.comment);
      return { body: `Saved your ${intent.rating}-star review${intent.comment ? ` ("${intent.comment}")` : ""}. Thanks!`, taskId };
    }
    case "dispute": {
      const t = await myActive(me, ["agreed", "picked_up", "handed_off"], ctx.contextTaskId);
      if (!t) return { body: "There's nothing in escrow to dispute right now." };
      await openDispute(t.id, me.id, intent.reason);
      return { body: "I opened a dispute and the payment is frozen. A resolver (Detour Ops) decides within 72 hours. Opening one doesn't count against you.", taskId: t.id };
    }
    case "cancel": {
      const items = ctx.contextTaskId ? await q<Task>(`select * from tasks where id = $1 and status in ${ACTIVE}`, [ctx.contextTaskId]) : await allActive(me);
      if (items.length === 0) return { body: "There's nothing active to cancel." };
      if (items.length > 1) return { body: `You have ${items.length} active items. Open the one you want to cancel and tell me "cancel" there.` };
      const msg = await cancelTask(items[0].id, me.id);
      return { body: msg === "Refund submitted." ? "Cancelled. The escrowed fee is being refunded." : "Cancelled. No money moved.", taskId: items[0].id };
    }
    case "auto_accept": {
      const n = await q<{ id: string }>("update trips set auto_accept = $2 where worker_id = $1 and status = 'planned' and return_by > now() returning id", [me.id, intent.on]);
      if (n.length === 0) return { body: "You have no upcoming trips. Tell me about one, like \"I'm driving to Target at 5, back by 7\"." };
      return intent.on
        ? { body: `OK. On your ${n.length} upcoming trip(s) I'll accept jobs paying at least ${formatUsd(me.min_fee_units)} that add at most ${me.max_detour_min} min.` }
        : { body: "OK. I'll ask you before accepting any job." };
    }
    default: return help("I didn't catch that.");
  }
}

function help(prefix?: string): Reply {
  return {
    body: `${prefix ? prefix + " " : ""}Just tell me what you want. For example:
• "Get my prepaid Target order to Windsor by 7, up to $7"
• "I'm driving to Target at 5 from Cary, back by 7"
• "Do it" / "No" to answer my suggestions · "Status"
• "Picked up" · "Code 123456" · "Got it" · "5 stars, fast"`,
    data: { suggest: ["Status"] },
  };
}

// ------------------------------------------------------------------ requester side
async function request(me: Profile, text: string, now: Date): Promise<Reply> {
  const parsed = await parseRequest(text.slice(0, 1000), now, { maxFeeUnits: me.default_budget_units });
  if (parsed.draft.prepaid === false) return { body: "I can only arrange prepaid orders. Workers never pay for your items. Pay for the order online first, then ask me again." };
  if (parsed.missing.length) {
    return { body: parsed.question ?? "Tell me a bit more about the errand.", data: { pending: { kind: "request", text } } };
  }
  const d = parsed.draft;
  const taskId = await createTask(me.id, {
    store_id: d.store_id!, delivery_zone: d.delivery_zone!, delivery_detail: null, order_reference: d.order_reference,
    pickup_window_start: fromCampusLocal(d.pickup_window_start!), pickup_window_end: fromCampusLocal(d.pickup_window_end!),
    delivery_deadline: fromCampusLocal(d.delivery_deadline!), package_size: d.package_size!, prepaid_confirmed: true,
    offered_fee_units: dollarsToUnits(d.offered_fee!), max_fee_units: dollarsToUnits(d.max_fee!),
    instructions: d.instructions, raw_text: text.slice(0, 1000),
  }, now);
  const task = (await one<Task>("select * from tasks where id = $1", [taskId]))!;
  const r = await matchAndPropose(task, me);
  return { ...r, body: `Posted: ${placeName(task.store_id)} → ${placeName(task.delivery_zone)} by ${fmtTime(task.delivery_deadline)}, opening at ${formatUsd(task.offered_fee_units)} (max ${formatUsd(task.max_fee_units)}). ${r.body}` };
}

async function matchAndPropose(task: Task, me: Profile): Promise<Reply> {
  const run = await runMatching(task.id, me.id);
  const rec = run.recommendation;
  if (!rec.offerId) return { body: `${rec.summary} I'll keep the request open. Say "search again" later.`, taskId: task.id, data: { suggest: ["Search again", "Cancel"] } };
  const offer = (await one<Offer & { worker_name: string }>(
    "select o.*, p.display_name as worker_name from offers o join profiles p on p.id = o.worker_id where o.id = $1", [rec.offerId]))!;
  const others = await q<{ worker_name: string }>(
    "select p.display_name as worker_name from offers o join profiles p on p.id = o.worker_id where o.task_id = $1 and o.status = 'proposed' and o.id <> $2", [task.id, offer.id]);
  const neg = offer.transcript.filter((t) => t.from === "worker_agent").length > 1 ? " (negotiated)" : "";
  return {
    taskId: task.id,
    body: `I talked to ${run.feasible} worker agent(s). Best fit: ${first(offer.worker_name)} at ${formatUsd(offer.fee_units)}${neg}, arriving by about ${fmtTime(offer.eta_delivery)}. ${rec.summary}\n\n` +
      `Say "do it" to hire ${first(offer.worker_name)}. That approves the terms and puts ${formatUsd(offer.fee_units)} in escrow once they're locked in.` +
      (others.length ? ` Or say "hire ${first(others[0].worker_name).toLowerCase()}".` : ""),
    data: { proposal: { kind: "hire", taskId: task.id, offerId: offer.id }, suggest: ["Do it", ...others.slice(0, 2).map((o) => `Hire ${first(o.worker_name)}`), "Search again"] },
  };
}

async function hireReply(me: Profile, taskId: string, offerId: string): Promise<Reply> {
  const r = await hire(taskId, me.id, offerId);
  if (r.funded) return { taskId, body: `Done. ${r.workerName}'s agent accepted, and ${formatUsd(r.feeUnits)} is in escrow. I'll message you when ${r.workerName} picks up your order.`, data: { suggest: ["Status"] } };
  if (r.workerApproved) return { taskId, body: `${r.workerName} accepted. I couldn't fund escrow automatically, so open the task to fund ${formatUsd(r.feeUnits)}.` };
  return { taskId, body: `Sent to ${r.workerName} at ${formatUsd(r.feeUnits)}. As soon as they accept, I'll put ${formatUsd(r.feeUnits)} in escrow. You don't need to do anything.`, data: { suggest: ["Status"] } };
}

async function hireByName(me: Profile, name: string, ctx: Ctx): Promise<Reply> {
  const task = await myOpenRequest(me, ctx.contextTaskId);
  if (!task) return { body: "You don't have an open request with offers." };
  const offer = await one<Offer>(
    `select o.* from offers o join profiles p on p.id = o.worker_id where o.task_id = $1 and o.status = 'proposed' and p.display_name ~* ('(^|[^a-z])' || $2) order by o.created_at desc limit 1`,
    [task.id, name.toLowerCase().replace(/[^a-z'-]/g, "")]);
  if (!offer) return { body: `I don't have a current offer from "${name}". Say "status" to see who's available.`, taskId: task.id };
  return hireReply(me, task.id, offer.id);
}

async function releaseTask(me: Profile, taskId: string): Promise<Reply> {
  const pay = await authorizeRelease(taskId, me.id);
  return pay.status === "released" ? { taskId, body: "" } : { taskId, body: "Release submitted. Waiting for the chain to confirm it." };
}

// ------------------------------------------------------------------ confirm / decline
async function confirm(me: Profile, ctx: Ctx): Promise<Reply> {
  const p = ctx.proposal;
  if (!p) return { body: "There's nothing waiting for a yes right now. Say \"status\" to see where things stand.", data: { suggest: ["Status"] } };
  if (p.kind === "hire") return hireReply(me, p.taskId, p.offerId);
  if (p.kind === "release") return releaseTask(me, p.taskId);
  const r = await approveAgreement(p.agreementId, p.version, me.id);
  const funded = await afterApproval(p.taskId, r.fullyApproved);
  return {
    taskId: p.taskId,
    body: r.fullyApproved
      ? `Accepted. The job is yours.${funded ? " The requester's fee is already in escrow. Head to the store and tell me \"picked up\"." : " I'll tell you when the fee is in escrow."}`
      : "Approved. Waiting on the other side.",
  };
}

async function decline(me: Profile, ctx: Ctx): Promise<Reply> {
  const p = ctx.proposal;
  if (p?.kind === "approve") {
    await declineAgreement(p.agreementId, me.id);
    return { taskId: p.taskId, body: "Passed. No money moved." };
  }
  if (p?.kind === "hire") return { taskId: p.taskId, body: "OK, I won't hire anyone yet. Say \"search again\" or \"hire <name>\" when you're ready.", data: { suggest: ["Search again"] } };
  return { body: "OK." };
}

// ------------------------------------------------------------------ worker side
async function postTrip(me: Profile, text: string, now: Date): Promise<Reply> {
  const { draft, question } = parseTripCommand(text, now, { homeZone: me.home_zone, transport: me.transport, capacity: me.capacity });
  if (question) return { body: question, data: { pending: { kind: "trip", text } } };
  await createTrip(me.id, {
    origin_zone: draft.origin_zone, store_id: draft.store_id!, return_zone: draft.return_zone,
    depart_at: draft.depart_at!, return_by: draft.return_by!, transport: draft.transport, capacity: draft.capacity, notes: null, auto_accept: draft.auto_accept,
  }, now);
  return {
    body: `Trip posted: ${placeName(draft.store_id!)} at ${fmtTime(draft.depart_at!)}, from ${placeName(draft.origin_zone)}, back to ${placeName(draft.return_zone)} by ${fmtTime(draft.return_by!)}. ` +
      (draft.auto_accept
        ? `I'll accept errands that pay at least ${formatUsd(me.min_fee_units)} and add at most ${me.max_detour_min} min, then tell you. Say "ask me first" if you'd rather approve each one.`
        : "I'll ask you before accepting any errand."),
    data: { suggest: ["Status", draft.auto_accept ? "Ask me first" : "Auto-accept"] },
  };
}

// ------------------------------------------------------------------ lookups (always scoped to the viewer)
async function myOpenRequest(me: Profile, taskId: string | null) {
  return one<Task>(`select * from tasks where requester_id = $1 and status = 'open' ${taskId ? "and id = $2" : ""} order by created_at desc limit 1`, taskId ? [me.id, taskId] : [me.id]);
}
async function myRequest(me: Profile, statuses: string[], taskId: string | null) {
  return one<Task>(`select * from tasks where requester_id = $1 and status = any($2) ${taskId ? "and id = $3" : ""} order by created_at desc limit 1`, taskId ? [me.id, statuses, taskId] : [me.id, statuses]);
}
async function myJob(me: Profile, statuses: string[], taskId: string | null) {
  return one<Task>(
    `select t.* from tasks t join agreements a on a.task_id = t.id and a.status = 'approved' and a.worker_id = $1
      where t.status = any($2) ${taskId ? "and t.id = $3" : ""} order by t.delivery_deadline limit 1`, taskId ? [me.id, statuses, taskId] : [me.id, statuses]);
}
async function myActive(me: Profile, statuses: string[], taskId: string | null) {
  return (await myRequest(me, statuses, taskId)) ?? (await myJob(me, statuses, taskId));
}
async function allActive(me: Profile) {
  return q<Task>(
    `select distinct t.* from tasks t left join agreements a on a.task_id = t.id and a.status in ('pending','approved')
      where t.status in ${ACTIVE} and (t.requester_id = $1 or a.worker_id = $1)`, [me.id]);
}
async function reviewable(me: Profile) {
  return one<Task>(
    `select t.* from tasks t join agreements a on a.task_id = t.id and a.status = 'approved'
      where t.status = 'completed' and $1 in (a.requester_id, a.worker_id)
        and not exists (select 1 from reviews r where r.task_id = t.id and r.reviewer_id = $1)
      order by t.completed_at desc nulls last limit 1`, [me.id]);
}

// ------------------------------------------------------------------ status
async function status(me: Profile): Promise<Reply> {
  const lines: string[] = [];
  const suggest = new Set<string>();
  let proposal: AgentMessageData["proposal"];
  const reqs = await q<Task>(`select * from tasks where requester_id = $1 and status in ${ACTIVE} order by created_at desc limit 5`, [me.id]);
  for (const t of reqs) {
    const head = `Your ${placeName(t.store_id)} → ${placeName(t.delivery_zone)} request (by ${fmtTime(t.delivery_deadline)})`;
    const ag = await one<Agreement & { worker_name: string }>(
      "select a.*, p.display_name as worker_name from agreements a join profiles p on p.id = a.worker_id where a.task_id = $1 and a.status in ('pending','approved') order by a.created_at desc limit 1", [t.id]);
    const pay = await one<Payment>("select * from payments where task_id = $1 order by created_at desc limit 1", [t.id]);
    const w = ag ? first(ag.worker_name) : "the worker";
    if (t.status === "open") {
      const best = await one<Offer & { worker_name: string }>(
        "select o.*, p.display_name as worker_name from offers o join profiles p on p.id = o.worker_id where o.task_id = $1 and o.status = 'proposed' and o.decision = 'accept' and o.expires_at > now() order by o.score desc limit 1", [t.id]);
      if (best) {
        lines.push(`${head}: ${first(best.worker_name)} is ready at ${formatUsd(best.fee_units)}. Say "do it" to hire them.`);
        proposal ??= { kind: "hire", taskId: t.id, offerId: best.id };
        suggest.add("Do it");
      } else { lines.push(`${head}: still looking.`); suggest.add("Search again"); }
    } else if (t.status === "negotiating") lines.push(`${head}: waiting for ${w} to accept.`);
    else if (t.status === "agreed") lines.push(`${head}: ${w} is assigned. ${pay?.status === "funded" ? "Fee is in escrow. Waiting for pickup." : "Escrow not funded yet."}`);
    else if (t.status === "picked_up" || t.status === "handed_off") {
      const hc = await one<{ salt: string }>("select salt from handoff_codes where task_id = $1", [t.id]);
      if (t.status === "picked_up") lines.push(`${head}: ${w} has your order. Your handoff code is ${hc ? deriveCode(t.id, hc.salt) : "—"}.`);
      else { lines.push(`${head}: delivered. Say "got it" to release ${pay ? formatUsd(pay.amount_units) : "the fee"}.`); proposal ??= { kind: "release", taskId: t.id }; suggest.add("Got it"); }
    } else if (t.status === "disputed") lines.push(`${head}: in dispute. Payment is frozen until the resolver decides.`);
  }
  const jobs = await q<Task & { ag_status: string; agreement_id: string; current_version: number; requester_name: string; fee: string; approved_by_me: boolean }>(
    `select t.*, a.status as ag_status, a.id as agreement_id, a.current_version, p.display_name as requester_name, v.terms->>'feeUnits' as fee,
            exists (select 1 from agreement_approvals x where x.agreement_id = a.id and x.version = a.current_version and x.profile_id = $1) as approved_by_me
       from agreements a join tasks t on t.id = a.task_id join profiles p on p.id = a.requester_id
       join agreement_versions v on v.agreement_id = a.id and v.version = a.current_version
      where a.worker_id = $1 and a.status in ('pending','approved') and t.status in ${ACTIVE} order by t.delivery_deadline limit 5`, [me.id]);
  for (const j of jobs) {
    const head = `Job for ${first(j.requester_name)}: ${placeName(j.store_id)} → ${placeName(j.delivery_zone)}, ${formatUsd(j.fee)}, by ${fmtTime(j.delivery_deadline)}`;
    if (j.ag_status === "pending") {
      if (j.approved_by_me) lines.push(`${head}: waiting on ${first(j.requester_name)}.`);
      else { lines.push(`${head}: needs your OK. Say "do it" to accept.`); proposal ??= { kind: "approve", taskId: j.id, agreementId: j.agreement_id, version: j.current_version }; suggest.add("Do it"); }
    } else if (j.status === "agreed") {
      const pay = await one<Payment>("select * from payments where task_id = $1 order by created_at desc limit 1", [j.id]);
      lines.push(`${head}: ${pay?.status === "funded" ? 'fee is in escrow. Go pick it up, then say "picked up".' : "waiting for the requester to fund escrow."}`);
      if (pay?.status === "funded") suggest.add("Picked up");
    } else if (j.status === "picked_up") lines.push(`${head}: on the way. Tell me the requester's code at handoff.`);
    else if (j.status === "handed_off") lines.push(`${head}: delivered. Waiting for the requester to release payment.`);
    else if (j.status === "disputed") lines.push(`${head}: in dispute.`);
  }
  const trips = await q<{ store_id: string; depart_at: Date; auto_accept: boolean }>(
    "select store_id, depart_at, auto_accept from trips where worker_id = $1 and status = 'planned' and return_by > now() order by depart_at limit 3", [me.id]);
  for (const tr of trips) lines.push(`Trip: ${placeName(tr.store_id)} at ${fmtDateTime(tr.depart_at)}. ${tr.auto_accept ? "I'll auto-accept jobs that fit your limits." : "I'll ask before accepting."}`);
  if (!lines.length) return help("Nothing active right now.");
  suggest.add("Status");
  return { body: lines.join("\n"), data: { proposal, suggest: [...suggest] } };
}
