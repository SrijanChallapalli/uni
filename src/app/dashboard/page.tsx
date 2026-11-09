import Link from "next/link";
import { AgentPanel } from "@/components/AgentPanel";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Empty, Pill, Section, TASK_STATUS_LABEL, taskTone } from "@/components/ui";
import { pageProfile } from "@/lib/auth";
import { q } from "@/lib/db";
import { placeName } from "@/lib/locations";
import { formatUsd } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import type { Task } from "@/lib/types";
import { markNotificationsRead } from "../actions";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const { profile, viewer } = await pageProfile();
  const [mine, jobs, notes] = await Promise.all([
    q<Task>("select * from tasks where requester_id = $1 order by (status in ('completed','cancelled')), created_at desc limit 20", [profile.id]),
    q<Task & { fee: number }>(
      `select t.*, v.terms->>'feeUnits' as fee from agreements a join tasks t on t.id = a.task_id
       join agreement_versions v on v.agreement_id = a.id and v.version = a.current_version
       where a.worker_id = $1 and a.status in ('pending','approved') and t.status not in ('completed','cancelled')
       order by t.delivery_deadline`, [profile.id]),
    q<{ id: number; title: string; body: string; task_id: string | null; read_at: Date | null; created_at: Date }>(
      "select * from notifications where profile_id = $1 order by id desc limit 8", [profile.id]),
  ]);
  const unread = notes.filter((n) => !n.read_at).length;

  return (
    <div>
      <AutoRefresh everyMs={6000} />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Hi, {profile.display_name.split(" ")[0]}</h1>
          <p className="muted">
            {profile.campus_email_verified_at ? <span className="font-semibold text-brand">✓ Verified Purdue student</span>
              : viewer.via === "demo" ? "Demo persona · not verified" : "Email not verified as @purdue.edu"}
          </p>
        </div>
        {!profile.is_demo && <Link href="/onboarding" className="text-sm text-brand underline">Agent preferences</Link>}
      </div>

      <div className="mt-4"><AgentPanel profile={profile} /></div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <Link href="/requests/new" className="card flex flex-col gap-1 border-brand/30 bg-brand text-brand-ink hover:brightness-110">
          <span className="text-2xl">🛍️</span><span className="font-semibold">Request a pickup</span>
          <span className="text-xs opacity-80">Prepaid store orders</span>
        </Link>
        <Link href="/trips/new" className="card flex flex-col gap-1 hover:bg-canvas">
          <span className="text-2xl">🚗</span><span className="font-semibold">Post a trip</span>
          <span className="text-xs text-muted">Earn on the way</span>
        </Link>
      </div>

      {notes.length > 0 && (
        <Section title={`Notifications${unread ? ` · ${unread} new` : ""}`} action={unread ? (
          <form action={markNotificationsRead}><button className="text-xs text-brand underline">Mark read</button></form>) : undefined}>
          <ul className="card divide-y divide-line p-0">
            {notes.map((n) => (
              <li key={n.id} className={`px-4 py-3 text-sm ${n.read_at ? "" : "bg-brand-soft/40"}`}>
                {n.task_id ? <Link href={`/tasks/${n.task_id}`} className="font-semibold hover:underline">{n.title}</Link> : <span className="font-semibold">{n.title}</span>}
                <p className="text-muted">{n.body}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Jobs you're doing">
        {jobs.length === 0 ? <Empty href="/trips/new" cta="Post a trip">No active jobs. Post a trip and your agent will find errands along your route.</Empty> : (
          <ul className="space-y-2">{jobs.map((t) => (
            <li key={t.id}><Link href={`/tasks/${t.id}`} className="card block hover:bg-canvas">
              <div className="flex items-center justify-between"><span className="font-semibold">{placeName(t.store_id)} → {placeName(t.delivery_zone)}</span><Pill tone={taskTone(t.status)}>{TASK_STATUS_LABEL[t.status]}</Pill></div>
              <p className="muted mt-1">Earn {formatUsd(Number(t.fee))} · by {fmtDateTime(t.delivery_deadline)}</p>
            </Link></li>))}
          </ul>
        )}
      </Section>

      <Section title="Your requests">
        {mine.length === 0 ? <Empty href="/requests/new" cta="Request a pickup">No requests yet.</Empty> : (
          <ul className="space-y-2">{mine.map((t) => (
            <li key={t.id}><Link href={`/tasks/${t.id}`} className="card block hover:bg-canvas">
              <div className="flex items-center justify-between gap-2"><span className="font-semibold">{placeName(t.store_id)} → {placeName(t.delivery_zone)}</span><Pill tone={taskTone(t.status)}>{TASK_STATUS_LABEL[t.status]}</Pill></div>
              <p className="muted mt-1">Offer {formatUsd(t.offered_fee_units)} (max {formatUsd(t.max_fee_units)}) · by {fmtDateTime(t.delivery_deadline)}</p>
            </Link></li>))}
          </ul>
        )}
      </Section>
    </div>
  );
}
