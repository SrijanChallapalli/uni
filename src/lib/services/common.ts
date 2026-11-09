import "server-only";
import { one, q, type Db } from "../db";
import type { Agreement, Payment, Task } from "../types";

/** An error whose message is safe and useful to show the user. */
export class UserError extends Error {}

export async function logEvent(db: Db, taskId: string, actorId: string | null, type: string, message: string, data: Record<string, unknown> = {}) {
  await q("insert into task_events (task_id, actor_id, type, message, data) values ($1,$2,$3,$4,$5)", [taskId, actorId, type, message, JSON.stringify(data)], db);
}

export async function notify(db: Db, profileIds: (string | null | undefined)[], taskId: string | null, title: string, body: string) {
  for (const id of new Set(profileIds.filter(Boolean) as string[])) {
    await q("insert into notifications (profile_id, task_id, title, body) values ($1,$2,$3,$4)", [id, taskId, title, body], db);
  }
}

export async function liveAgreement(db: Db, taskId: string, lock = false): Promise<Agreement | null> {
  return one<Agreement>(
    `select * from agreements where task_id = $1 and status in ('pending','approved') order by created_at desc limit 1${lock ? " for update" : ""}`,
    [taskId], db);
}

export async function livePayment(db: Db, taskId: string, lock = false): Promise<Payment | null> {
  return one<Payment>(
    `select * from payments where task_id = $1 order by created_at desc limit 1${lock ? " for update" : ""}`, [taskId], db);
}

export async function lockTask(db: Db, taskId: string): Promise<Task> {
  const t = await one<Task>("select * from tasks where id = $1 for update", [taskId], db);
  if (!t) throw new UserError("Task not found.");
  return t;
}

/** Role of a profile on a task, or null if it has no access. */
export async function roleOn(db: Db, task: Task, profileId: string): Promise<"requester" | "worker" | "candidate" | null> {
  if (task.requester_id === profileId) return "requester";
  const ag = await one("select 1 from agreements where task_id = $1 and worker_id = $2 and status in ('pending','approved')", [task.id, profileId], db);
  if (ag) return "worker";
  const off = await one("select 1 from offers where task_id = $1 and worker_id = $2 and status in ('proposed','selected')", [task.id, profileId], db);
  return off ? "candidate" : null;
}

export type AgentProposal =
  | { kind: "hire"; taskId: string; offerId: string }
  | { kind: "approve"; taskId: string; agreementId: string; version: number }
  | { kind: "release"; taskId: string };

export interface AgentMessageData {
  /** Something the agent is waiting for the person to say yes to. Only the latest agent message counts. */
  proposal?: AgentProposal;
  /** A half-finished instruction the agent asked a follow-up question about. */
  pending?: { kind: "request" | "trip" | "review"; text?: string; taskId?: string };
  /** Quick replies to show. */
  suggest?: string[];
}

/** The person's own agent posts a message into their conversation. */
export async function agentSay(db: Db, profileId: string | null | undefined, taskId: string | null, body: string, data: AgentMessageData = {}) {
  if (!profileId) return;
  await q("insert into agent_messages (profile_id, task_id, role, body, data) values ($1,$2,'agent',$3,$4)",
    [profileId, taskId, body.slice(0, 2000), JSON.stringify(data)], db);
}
