import Link from "next/link";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ActionButton } from "@/components/ActionButton";
import { Empty, Pill, Section, TASK_STATUS_LABEL, taskTone } from "@/components/ui";
import { pageProfile } from "@/lib/auth";
import { q } from "@/lib/db";
import { MODE_LABEL, placeName } from "@/lib/locations";
import { formatUsd } from "@/lib/money";
import { fmtDateTime, fmtTime } from "@/lib/time";
import type { Task, Trip } from "@/lib/types";
import { cancelTripAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function Jobs({ searchParams }: { searchParams: Promise<{ trip?: string }> }) {
  const { profile } = await pageProfile();
  const sp = await searchParams;
  const [toApprove, active, trips] = await Promise.all([
    q<Task & { fee: string; version: number }>(
      `select t.*, v.terms->>'feeUnits' as fee, a.current_version as version from agreements a
       join tasks t on t.id = a.task_id join agreement_versions v on v.agreement_id = a.id and v.version = a.current_version
       where a.worker_id = $1 and a.status = 'pending'
         and not exists (select 1 from agreement_approvals x where x.agreement_id = a.id and x.version = a.current_version and x.profile_id = $1)`, [profile.id]),
    q<Task & { fee: string }>(
      `select t.*, v.terms->>'feeUnits' as fee from agreements a join tasks t on t.id = a.task_id
       join agreement_versions v on v.agreement_id = a.id and v.version = a.current_version
       where a.worker_id = $1 and a.status = 'approved' order by t.delivery_deadline desc limit 20`, [profile.id]),
    q<Trip & { busy: boolean }>(
      `select tr.*, exists (select 1 from assignments a where a.trip_id = tr.id and a.active) as busy
       from trips tr where tr.worker_id = $1 and tr.status = 'planned' and tr.return_by > now() order by tr.depart_at`, [profile.id]),
  ]);

  return (
    <div>
      <AutoRefresh everyMs={6000} />
      <h1 className="text-2xl font-bold">Jobs &amp; trips</h1>
      {sp.trip === "posted" && <p role="status" className="mt-2 rounded-lg bg-brand-soft px-3 py-2 text-sm text-brand">Trip posted. Your agent will evaluate matching requests when requesters search.</p>}

      <Section title="Waiting for your approval">
        {toApprove.length === 0 ? <Empty>Nothing to approve right now.</Empty> : (
          <ul className="space-y-2">{toApprove.map((t) => (
            <li key={t.id}><Link href={`/tasks/${t.id}`} className="card block border-accent/50 hover:bg-canvas">
              <div className="flex justify-between"><span className="font-semibold">{placeName(t.store_id)} → {placeName(t.delivery_zone)}</span><span className="font-bold">{formatUsd(Number(t.fee))}</span></div>
              <p className="muted">Terms v{t.version} · deliver by {fmtDateTime(t.delivery_deadline)} · tap to review &amp; approve</p>
            </Link></li>))}</ul>
        )}
      </Section>

      <Section title="Your trips" action={<Link href="/trips/new" className="text-sm text-brand underline">Post a trip</Link>}>
        {trips.length === 0 ? <Empty href="/trips/new" cta="Post a trip">No upcoming trips.</Empty> : (
          <ul className="space-y-2">{trips.map((t) => (
            <li key={t.id} className="card">
              <div className="flex items-center justify-between"><span className="font-semibold">{placeName(t.store_id)}</span>{t.busy ? <Pill tone="amber">Carrying a task</Pill> : <Pill tone="blue">Open for errands</Pill>}</div>
              <p className="muted">{fmtDateTime(t.depart_at)} – {fmtTime(t.return_by)} · {MODE_LABEL[t.transport]} · from {placeName(t.origin_zone)}</p>
              {!t.busy && <ActionButton className="mt-2" action={cancelTripAction.bind(null, t.id)} label="Cancel trip" variant="secondary" confirm="Cancel this trip? Pending offers from it expire." />}
            </li>))}</ul>
        )}
      </Section>

      <Section title="Accepted jobs">
        {active.length === 0 ? <Empty>No accepted jobs yet.</Empty> : (
          <ul className="space-y-2">{active.map((t) => (
            <li key={t.id}><Link href={`/tasks/${t.id}`} className="card block hover:bg-canvas">
              <div className="flex items-center justify-between gap-2"><span className="font-semibold">{placeName(t.store_id)} → {placeName(t.delivery_zone)}</span><Pill tone={taskTone(t.status)}>{TASK_STATUS_LABEL[t.status]}</Pill></div>
              <p className="muted">{formatUsd(Number(t.fee))} · by {fmtDateTime(t.delivery_deadline)}</p>
            </Link></li>))}</ul>
        )}
      </Section>
    </div>
  );
}
