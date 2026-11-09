import Link from "next/link";
import { Empty, Pill, TxLink } from "@/components/ui";
import { pageProfile } from "@/lib/auth";
import { q } from "@/lib/db";
import { PAYMENT_STATUS_LABEL, PENDING_LABEL } from "@/lib/escrow/state";
import { placeName } from "@/lib/locations";
import { formatUsd } from "@/lib/money";
import { fmtDateTime } from "@/lib/time";
import type { Payment } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function Payments() {
  const { profile } = await pageProfile();
  const rows = await q<Payment & { store_id: string; delivery_zone: string; requester_id: string; worker_id: string }>(
    `select p.*, t.store_id, t.delivery_zone, a.requester_id, a.worker_id from payments p
     join agreements a on a.id = p.agreement_id join tasks t on t.id = p.task_id
     where a.requester_id = $1 or a.worker_id = $1 order by p.updated_at desc limit 50`, [profile.id]);
  const events = rows.length ? await q<{ payment_id: string; source: string; event_type: string; tx_hash: string; applied: boolean; note: string | null; created_at: Date }>(
    "select payment_id, source, event_type, tx_hash, applied, note, created_at from payment_events where payment_id = any($1) order by id", [rows.map((r) => r.id)]) : [];
  const earned = rows.filter((r) => r.worker_id === profile.id && r.status === "released").reduce((s, r) => s + r.amount_units, 0);
  const spent = rows.filter((r) => r.requester_id === profile.id && r.status === "released").reduce((s, r) => s + r.amount_units, 0);

  return (
    <div>
      <h1 className="text-2xl font-bold">Payment history</h1>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="card"><p className="text-xs text-muted">Earned (released to you)</p><p className="text-2xl font-bold">{formatUsd(earned)}</p></div>
        <div className="card"><p className="text-xs text-muted">Paid in fees</p><p className="text-2xl font-bold">{formatUsd(spent)}</p></div>
      </div>
      <p className="muted mt-2">Only delivery fees go through escrow. Statuses change only on confirmed events, not when a transaction is submitted.</p>
      <ul className="mt-4 space-y-2">
        {rows.length === 0 && <Empty>No payments yet.</Empty>}
        {rows.map((p) => (
          <li key={p.id} className="card">
            <div className="flex items-center justify-between gap-2">
              <Link href={`/tasks/${p.task_id}`} className="font-semibold underline">{placeName(p.store_id)} → {placeName(p.delivery_zone)}</Link>
              <span className="text-lg font-bold">{p.worker_id === profile.id ? "+" : "−"}{formatUsd(p.amount_units)}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              <Pill tone={p.status === "released" ? "green" : p.status === "disputed" ? "red" : "blue"}>{PAYMENT_STATUS_LABEL[p.status]}</Pill>
              <Pill tone={p.mode === "simulated" ? "amber" : "blue"}>{p.mode === "simulated" ? "Simulated" : "Arc Testnet"}</Pill>
              {p.resolved_by_resolver && <Pill tone="gray">Resolver decision</Pill>}
            </div>
            {p.pending_action && <p className="mt-1 text-xs text-[#8a5a14]">{PENDING_LABEL[p.pending_action]}</p>}
            <details className="mt-2 text-xs text-muted">
              <summary className="cursor-pointer">Escrow events</summary>
              <ul className="mt-1 space-y-1">
                {events.filter((e) => e.payment_id === p.id).map((e, i) => (
                  <li key={i}>{fmtDateTime(e.created_at)} · {e.event_type} via {e.source.replace("_", " ")} {e.applied ? "✓" : `(not applied: ${e.note})`} · <TxLink hash={e.tx_hash} chainId={p.chain_id} /></li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
