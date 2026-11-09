import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/ActionButton";
import { Empty } from "@/components/ui";
import { pageProfile } from "@/lib/auth";
import { q } from "@/lib/db";
import { placeName } from "@/lib/locations";
import { formatUsd } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import { resolveAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function Resolver() {
  const { profile } = await pageProfile();
  if (!profile.is_resolver) notFound();
  const rows = await q<{ task_id: string; reason: string; respond_by: Date; opened_at: Date; store_id: string; delivery_zone: string; amount_units: number; payment_status: string; pending_action: string | null; req: string; wrk: string }>(
    `select d.task_id, d.reason, d.respond_by, d.opened_at, t.store_id, t.delivery_zone, p.amount_units, p.status as payment_status, p.pending_action,
       rq.display_name as req, wk.display_name as wrk
     from disputes d join tasks t on t.id = d.task_id
     join payments p on p.task_id = t.id and p.status = 'disputed'
     join agreements a on a.id = p.agreement_id join profiles rq on rq.id = a.requester_id join profiles wk on wk.id = a.worker_id
     where d.status = 'open' and rq.is_demo = $1 order by d.respond_by`, [profile.is_demo]);
  return (
    <div>
      <h1 className="text-2xl font-bold">Dispute queue</h1>
      <p className="muted mt-1">You are the disclosed centralized resolver. You can pay the agreed worker or refund the requester — never anyone else. Missed deadlines refund the requester automatically.</p>
      <ul className="mt-4 space-y-3">
        {rows.length === 0 && <Empty>No open disputes.</Empty>}
        {rows.map((d) => (
          <li key={d.task_id} className="card">
            <Link href={`/tasks/${d.task_id}`} className="font-semibold underline">{placeName(d.store_id)} → {placeName(d.delivery_zone)}</Link>
            <p className="muted">{d.req} (requester) vs {d.wrk} (worker) · {formatUsd(d.amount_units)} frozen · decide by {fmtDateTime(d.respond_by)}</p>
            <p className="mt-2 rounded-lg bg-canvas p-2 text-sm">“{d.reason}”</p>
            {d.pending_action ? <p className="mt-2 text-sm text-[#8a5a14]">Resolution submitted, waiting for confirmation.</p> : (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <ActionForm action={resolveAction.bind(null, d.task_id, true)} submitLabel="Pay worker" variant="secondary">
                  <input className="input" name="note" placeholder="Note (optional)" maxLength={500} />
                </ActionForm>
                <ActionForm action={resolveAction.bind(null, d.task_id, false)} submitLabel="Refund requester" variant="secondary">
                  <input className="input" name="note" placeholder="Note (optional)" maxLength={500} />
                </ActionForm>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
