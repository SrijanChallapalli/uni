import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton, ActionForm } from "@/components/ActionButton";
import { AgentPanel } from "@/components/AgentPanel";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Empty, KV, Pill, Section, TASK_STATUS_LABEL, taskTone, TxLink } from "@/components/ui";
import type { AgreementTerms } from "@/lib/agreement";
import { pageProfile } from "@/lib/auth";
import { one, q } from "@/lib/db";
import { PAYMENT_STATUS_LABEL, PENDING_LABEL } from "@/lib/escrow/state";
import { placeName, SIZE_LABEL } from "@/lib/locations";
import { formatUsd, unitsToDollarString } from "@/lib/money";
import { agreementView } from "@/lib/services/agreements";
import { handoffCodeFor, runTimeouts } from "@/lib/services/lifecycle";
import { fmtDateTime, fmtTime, toCampusLocal } from "@/lib/time";
import type { Offer, Payment, Profile, Task } from "@/lib/types";
import {
  approveAction, cancelTaskAction, declineAction, disputeAction, editTermsAction, fundAction, pickedUpAction,
  releaseAction, reviewAction, runMatchingAction, selectOfferAction, verifyHandoffAction,
} from "../../actions";

export const dynamic = "force-dynamic";

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { profile: me } = await pageProfile();
  await runTimeouts().catch((e) => console.warn("[timeouts]", e));

  const task = await one<Task>("select * from tasks where id = $1", [id]);
  if (!task) notFound();
  const av = await agreementView(id);
  const isRequester = task.requester_id === me.id;
  const isWorker = av?.agreement.worker_id === me.id;
  const myOffer = await one<Offer>("select * from offers where task_id = $1 and worker_id = $2 order by created_at desc limit 1", [id, me.id]);
  const isResolver = me.is_resolver && task.status === "disputed";
  if (!isRequester && !isWorker && !myOffer && !isResolver) notFound(); // no cross-user access

  const [requester, worker, payment, events, offers, run, dispute, reviews, code] = await Promise.all([
    one<Profile>("select id, display_name, campus_email_verified_at, is_demo from profiles where id = $1", [task.requester_id]),
    av ? one<Profile>("select id, display_name, campus_email_verified_at, is_demo from profiles where id = $1", [av.agreement.worker_id]) : null,
    one<Payment>("select * from payments where task_id = $1 order by created_at desc limit 1", [id]),
    q<{ id: number; type: string; message: string; created_at: Date; data: { txHash?: string } }>("select * from task_events where task_id = $1 order by id", [id]),
    isRequester ? q<Offer & { worker_name: string }>(
      `select o.*, p.display_name as worker_name from offers o join profiles p on p.id = o.worker_id
       where o.task_id = $1 and o.status in ('proposed','selected','declined') and o.task_terms_version = $2
       order by (o.decision = 'reject'), o.score desc nulls last`, [id, task.terms_version]) : Promise.resolve([]),
    isRequester ? one<{ candidates: { evaluated: number; feasible: number; filtered: { code: string; message: string }[] }; recommendation: { offerId: string | null; summary: string; tradeoffs: string[]; source: string }; created_at: Date }>(
      "select * from match_runs where task_id = $1 order by created_at desc limit 1", [id]) : null,
    one<{ reason: string; status: string; resolver_label: string; respond_by: Date; opened_by: string; resolution_note: string | null }>(
      "select * from disputes where task_id = $1 order by opened_at desc limit 1", [id]),
    q<{ reviewer_id: string; rating: number; comment: string | null; reviewee_role: string }>("select * from reviews where task_id = $1", [id]),
    one<{ salt: string; used_at: Date | null }>("select salt, used_at from handoff_codes where task_id = $1", [id]),
  ]);

  const terms = av?.current.terms as AgreementTerms | undefined;
  const approved = av?.agreement.status === "approved";
  const party = isRequester || isWorker;
  const iApprovedCurrent = av?.approvals.some((a) => a.version === av.agreement.current_version && a.profile_id === me.id);
  const theyApprovedCurrent = av?.approvals.some((a) => a.version === av.agreement.current_version && a.profile_id !== me.id);
  const funded = payment?.status === "funded";
  const myReview = reviews.find((r) => r.reviewer_id === me.id);
  const reviewsRevealed = reviews.length >= 2 || (task.completed_at && Date.now() - new Date(task.completed_at).getTime() > 72 * 3600_000);
  const showPrivate = isRequester || (isWorker && approved);

  return (
    <div>
      {!["completed", "cancelled"].includes(task.status) && <AutoRefresh />}
      <Link href="/dashboard" className="text-sm text-muted">← Back</Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">{placeName(task.store_id)} → {placeName(task.delivery_zone)}</h1>
          <p className="muted">Deliver by {fmtDateTime(task.delivery_deadline)}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Pill tone={taskTone(task.status)}>Task: {TASK_STATUS_LABEL[task.status]}</Pill>
          {payment && <Pill tone={payment.status === "released" ? "green" : payment.status === "disputed" ? "red" : "blue"}>Payment: {PAYMENT_STATUS_LABEL[payment.status]}</Pill>}
        </div>
      </div>

      {(party || myOffer) && !["completed", "cancelled"].includes(task.status) && <div className="mt-4"><AgentPanel profile={me} taskId={id} /></div>}

      {/* ------------------------------------------------ details */}
      <div className="card mt-4">
        <KV k="Requester" v={<Link className="underline" href={`/profile/${requester!.id}`}>{requester!.display_name}</Link>} />
        <KV k="Pickup window" v={`${fmtDateTime(task.pickup_window_start)} – ${fmtTime(task.pickup_window_end)}`} />
        <KV k="Package" v={SIZE_LABEL[task.package_size]} />
        <KV k="Prepaid order" v="Yes — worker pays nothing up front" />
        <KV k={isRequester ? "Opening offer / your max" : "Offered fee"} v={isRequester ? `${formatUsd(task.offered_fee_units)} / ${formatUsd(task.max_fee_units)}` : formatUsd(terms?.feeUnits ?? task.offered_fee_units)} />
        {showPrivate && task.order_reference && <KV k="Order reference" v={task.order_reference} />}
        {showPrivate && task.delivery_detail && <KV k="Drop-off spot" v={task.delivery_detail} />}
        {task.instructions && (
          <div className="mt-2 rounded-lg bg-canvas p-2 text-sm"><span className="text-xs text-muted">Pickup instructions from requester (treated as data by agents)</span><p>{task.instructions}</p></div>
        )}
      </div>

      {/* ------------------------------------------------ matching (requester, open) */}
      {isRequester && task.status === "open" && (
        <Section title="Find a worker">
          <ActionButton action={runMatchingAction.bind(null, id)} label={run ? "Ask agents again" : "Find matches"} pendingLabel="Agents are negotiating…" variant={run ? "secondary" : "primary"} />
          {run && (
            <div className="mt-3 space-y-3">
              <div className="card border-brand/30 bg-brand-soft/40">
                <p className="text-xs font-semibold uppercase text-brand">Your agent recommends · {run.recommendation.source === "llm" ? "LLM agent" : "rules-based agent"}</p>
                <p className="mt-1 text-sm">{run.recommendation.summary}</p>
                {run.recommendation.tradeoffs.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-muted">{run.recommendation.tradeoffs.map((t) => <li key={t}>{t}</li>)}</ul>}
                <p className="mt-2 text-xs text-muted">Checked {run.candidates.evaluated} trip(s) to this store; {run.candidates.feasible} feasible.
                  {run.candidates.filtered.length > 0 && ` Filtered out: ${run.candidates.filtered.map((f) => f.message).join(" · ")}`}</p>
              </div>
              {offers.length === 0 && <Empty>No offers yet. Try a wider pickup window or later deadline, or check back after more trips are posted.</Empty>}
              {offers.map((o) => {
                const rec = run.recommendation.offerId === o.id;
                const expired = new Date(o.expires_at) < new Date();
                const overBudget = o.fee_units > task.max_fee_units;
                return (
                  <div key={o.id} className={`card ${rec ? "ring-2 ring-brand" : ""}`}>
                    <div className="flex items-center justify-between gap-2">
                      <Link href={`/profile/${o.worker_id}`} className="font-semibold underline">{o.worker_name}</Link>
                      <div className="flex gap-1">
                        {rec && <Pill tone="green">Recommended</Pill>}
                        <Pill tone={o.decision === "accept" ? "green" : o.decision === "counter" ? "amber" : "gray"}>
                          {o.decision === "accept" ? ((o.transcript ?? []).length > 2 ? "Negotiated" : "Accepts") : o.decision === "counter" ? "Over budget" : "Declined"}
                        </Pill>
                      </div>
                    </div>
                    <p className="mt-1 text-2xl font-bold">{formatUsd(o.fee_units)}</p>
                    <p className="text-sm">{o.summary}</p>
                    <p className="mt-1 text-xs text-muted">Worker agent: {o.agent_source === "llm" ? "LLM (validated within limits)" : "rules-based"}</p>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                      <div className="rounded-lg bg-canvas p-2"><p className="text-xs text-muted">Extra effort for worker</p><p className="font-semibold">{o.effort_low_min}–{o.effort_high_min} min</p></div>
                      <div className="rounded-lg bg-canvas p-2"><p className="text-xs text-muted">Arrives by (latest est.)</p><p className="font-semibold">{fmtTime(o.eta_delivery)}</p></div>
                    </div>
                    {(o.transcript ?? []).length > 1 && (
                      <details className="mt-2 text-xs" open={(o.transcript ?? []).length > 2}>
                        <summary className="cursor-pointer text-muted">How the agents negotiated ({o.transcript.filter((x) => x.from === "worker_agent").length} round{o.transcript.filter((x) => x.from === "worker_agent").length === 1 ? "" : "s"})</summary>
                        <ol className="mt-1 space-y-1">
                          {o.transcript.map((x, i) => (
                            <li key={i} className={`rounded-lg px-2 py-1 ${x.from === "requester_agent" ? "bg-brand-soft/50" : "bg-canvas"}`}>
                              <span className="font-semibold">{x.from === "requester_agent" ? "Your agent" : `${o.worker_name.split(" ")[0]}'s agent`}</span>
                              {" · "}{x.kind === "offer" ? "offers" : x.kind === "walk_away" ? "walks away" : x.kind === "reject" ? "declines" : x.kind === "accept" ? "accepts" : "counters"} {formatUsd(x.feeUnits)}: {x.text}
                            </li>
                          ))}
                        </ol>
                      </details>
                    )}
                    <details className="mt-2 text-xs text-muted">
                      <summary className="cursor-pointer">Why this ranking · assumptions</summary>
                      <p className="mt-1">Total trip with your errand: {o.factors.tripTotalLowMin ?? "?"}–{o.trip_total_min} min (their trip alone: {o.factors.baselineTripMin ?? "?"} min). Extra effort is the difference.</p>
                      <ul className="mt-1 list-disc pl-4">{(o.factors.notes ?? []).map((n) => <li key={n}>{n}</li>)}</ul>
                      <ul className="mt-1 list-disc pl-4">{(o.factors.assumptions ?? []).map((n) => <li key={n}>{n}</li>)}</ul>
                    </details>
                    {o.decision !== "reject" && (
                      expired ? <p className="mt-2 text-sm text-muted">Offer expired. Ask agents again for fresh offers.</p>
                        : overBudget ? <p className="mt-2 text-sm text-danger">Above your {formatUsd(task.max_fee_units)} max. Your agent won&apos;t accept it.</p>
                        : <ActionButton className="mt-3" action={selectOfferAction.bind(null, id, o.id)} label={`Approve terms at ${formatUsd(o.fee_units)}`} pendingLabel="Checking it's still feasible…"
                            confirm={`You're approving an agreement with ${o.worker_name} for ${formatUsd(o.fee_units)}. Nothing is charged until you fund escrow, and ${o.worker_name} must approve the same terms.`} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Section>
      )}

      {/* ------------------------------------------------ worker candidate view (offer made, no agreement) */}
      {!isRequester && !isWorker && myOffer && (
        <Section title="Your agent's offer">
          <div className="card text-sm"><p>Your agent proposed <strong>{formatUsd(myOffer.fee_units)}</strong> ({myOffer.decision}). {myOffer.summary}</p>
            <p className="mt-1 text-muted">You&apos;ll be asked to approve if the requester picks you. Nothing is committed yet.</p></div>
        </Section>
      )}

      {/* ------------------------------------------------ agreement */}
      {av && terms && party && (
        <Section title={`Agreement · version ${av.agreement.current_version}`}>
          <div className="card">
            <KV k="Worker" v={<Link className="underline" href={`/profile/${worker!.id}`}>{worker!.display_name}</Link>} />
            <KV k="Service fee (escrowed)" v={<span className="text-lg">{formatUsd(terms.feeUnits)}</span>} />
            <KV k="Pickup window" v={`${fmtTime(terms.pickupWindowStart)} – ${fmtTime(terms.pickupWindowEnd)}`} />
            <KV k="Deliver by" v={fmtDateTime(terms.deliveryDeadline)} />
            <KV k="Completion" v="One-time handoff code, then requester releases" />
            <KV k="Dispute resolver" v={terms.disputeResolver} />
            <KV k="Requester approval" v={av.approvals.some((a) => a.version === av.agreement.current_version && a.profile_id === av.agreement.requester_id) ? "✓ Approved this version" : "Waiting"} />
            <KV k="Worker approval" v={av.approvals.some((a) => a.version === av.agreement.current_version && a.profile_id === av.agreement.worker_id) ? "✓ Approved this version" : "Waiting"} />
            <details className="mt-2 text-xs text-muted">
              <summary className="cursor-pointer">Cancellation rules &amp; timeouts</summary>
              <ul className="mt-1 list-disc pl-4">{terms.cancellationRules.map((r) => <li key={r}>{r}</li>)}</ul>
              <p className="mt-1">Resolver must decide within {terms.timeouts.resolveHours}h; otherwise the fee is refunded to the requester (enforced on-chain by a permissionless timeout).</p>
              <p className="mt-1">Terms hash: <span className="font-mono">{av.current.terms_hash.slice(0, 16)}…</span></p>
            </details>
            {av.versions.length > 1 && (
              <p className="mt-2 text-xs text-muted">History: {av.versions.map((v) => `v${v.version} ${formatUsd(v.terms.feeUnits)}`).join(" → ")}. Editing material terms resets approvals.</p>
            )}
          </div>
          {!approved && (
            <div className="mt-3 space-y-3">
              {!iApprovedCurrent ? (
                <ActionButton action={approveAction.bind(null, id, av.agreement.id, av.agreement.current_version)} label={`Approve v${av.agreement.current_version} — ${formatUsd(terms.feeUnits)}`}
                  pendingLabel="Re-checking feasibility…" confirm={isWorker
                    ? `You're committing to pick up at ${placeName(task.store_id)} and deliver by ${fmtTime(terms.deliveryDeadline)} for ${formatUsd(terms.feeUnits)}. You won't pay anything.`
                    : `Approve these terms for ${formatUsd(terms.feeUnits)}?`} />
              ) : (
                <p className="rounded-xl bg-canvas p-3 text-sm">You approved v{av.agreement.current_version}. {theyApprovedCurrent ? "" : "Waiting for the other person."}</p>
              )}
              <details className="card">
                <summary className="cursor-pointer text-sm font-semibold">Propose different terms</summary>
                <ActionForm action={editTermsAction.bind(null, id, av.agreement.id)} submitLabel="Propose new version" variant="secondary" className="mt-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="label" htmlFor="fee">Fee ($)</label><input className="input" id="fee" name="fee" inputMode="decimal" defaultValue={unitsToDollarString(terms.feeUnits)} required /></div>
                    <div><label className="label" htmlFor="ndl">Deliver by</label><input className="input" id="ndl" name="delivery_deadline" type="datetime-local" defaultValue={toCampusLocal(new Date(terms.deliveryDeadline))} required /></div>
                  </div>
                  <p className="text-xs text-muted">Creates version {av.agreement.current_version + 1}. Earlier approvals stop counting.</p>
                </ActionForm>
              </details>
              <ActionButton action={declineAction.bind(null, id, av.agreement.id)} label="Decline these terms" variant="danger" confirm="Decline? The request goes back to open. No money has moved." />
            </div>
          )}
        </Section>
      )}

      {/* ------------------------------------------------ escrow & handoff */}
      {payment && party && (
        <Section title="Escrow & handoff">
          <div className="card">
            <KV k="Escrow mode" v={payment.mode === "simulated" ? <Pill tone="amber">Simulated (no real chain)</Pill> : <Pill tone="blue">Arc Testnet · test USDC</Pill>} />
            <KV k="Amount" v={formatUsd(payment.amount_units)} />
            <KV k="Confirmed status" v={PAYMENT_STATUS_LABEL[payment.status]} />
            {payment.pending_action && <KV k="Pending" v={<span className="text-[#8a5a14]">{PENDING_LABEL[payment.pending_action]}</span>} />}
            {payment.fund_tx && <KV k="Funding tx" v={<TxLink hash={payment.fund_tx} chainId={payment.chain_id} />} />}
            {payment.release_tx && <KV k="Release tx" v={<TxLink hash={payment.release_tx} chainId={payment.chain_id} />} />}
            {payment.refund_tx && <KV k="Refund tx" v={<TxLink hash={payment.refund_tx} chainId={payment.chain_id} />} />}
            {payment.mode === "arc_testnet" && <p className="mt-2 text-xs text-muted">Custodial demo: the app&apos;s platform signer funds and releases escrow only when you authorize it here. Statuses update from confirmed events delivered by QuickNode Streams.</p>}
          </div>

          <div className="mt-3 space-y-3">
            {isRequester && task.status === "agreed" && payment.status === "awaiting_funding" && !payment.pending_action && (
              <ActionButton action={fundAction.bind(null, id)} label={`Fund escrow · ${formatUsd(payment.amount_units)}`} pendingLabel="Submitting…"
                confirm={`${formatUsd(payment.amount_units)} (the delivery fee only) will be held in escrow until you confirm the handoff. Your order itself is already paid.`} />
            )}
            {isWorker && task.status === "agreed" && (
              funded ? <ActionButton action={pickedUpAction.bind(null, id)} label="I picked up the order" pendingLabel="Saving…" />
                : <p className="rounded-xl bg-canvas p-3 text-sm">Wait for the requester to fund escrow before heading in. You&apos;ll get a notification.</p>
            )}
            {isRequester && code && !code.used_at && funded && ["agreed", "picked_up"].includes(task.status) && (
              <div className="card border-brand/40 text-center">
                <p className="text-xs uppercase text-muted">Your one-time handoff code</p>
                <p className="my-2 font-mono text-4xl font-bold tracking-[0.3em]">{handoffCodeFor(id, code.salt)}</p>
                <p className="text-xs text-muted">Only tell it to your worker in person when you receive the package. It confirms receipt, not what&apos;s inside.</p>
              </div>
            )}
            {isWorker && task.status === "picked_up" && (
              <ActionForm action={verifyHandoffAction.bind(null, id)} submitLabel="Confirm handoff" pendingLabel="Verifying…">
                <label className="label" htmlFor="code">Handoff code from the requester</label>
                <input className="input text-center font-mono text-2xl tracking-[0.3em]" id="code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required placeholder="••••••" />
                <p className="text-xs text-muted">5 attempts, then a 15-minute lock.</p>
              </ActionForm>
            )}
            {isRequester && task.status === "handed_off" && funded && !payment.pending_action && (
              <ActionButton action={releaseAction.bind(null, id)} label={`Confirm receipt & release ${formatUsd(payment.amount_units)}`} pendingLabel="Releasing…"
                confirm={`Your worker entered your handoff code. Check the package first: releasing sends ${formatUsd(payment.amount_units)} to ${worker?.display_name} and can't be undone. If something's wrong, open a dispute instead.`} />
            )}
            {isWorker && task.status === "handed_off" && <p className="rounded-xl bg-brand-soft p-3 text-sm">Handoff verified. Payment releases when the requester confirms (or automatically after 24h).</p>}
          </div>
        </Section>
      )}

      {/* ------------------------------------------------ dispute */}
      {dispute && (party || isResolver) && (
        <Section title="Dispute">
          <div className="card text-sm">
            <KV k="Status" v={dispute.status.replace("_", " ")} />
            <KV k="Reason" v={dispute.reason} />
            <KV k="Resolver" v={dispute.resolver_label} />
            <KV k="Decision due" v={fmtDateTime(dispute.respond_by)} />
            {dispute.resolution_note && <KV k="Resolver note" v={dispute.resolution_note} />}
            <p className="mt-2 text-xs text-muted">Opening a dispute does not lower anyone&apos;s reputation. If the resolver misses the deadline, the fee is refunded to the requester.</p>
            {isResolver && <Link href="/resolver" className="mt-2 inline-block font-semibold text-brand underline">Resolve in the disputes queue</Link>}
          </div>
        </Section>
      )}
      {party && funded && ["agreed", "picked_up", "handed_off"].includes(task.status) && !payment?.pending_action && (
        <details className="card mt-4">
          <summary className="cursor-pointer text-sm font-semibold text-danger">Something went wrong? Open a dispute</summary>
          <ActionForm action={disputeAction.bind(null, id)} submitLabel="Freeze payment & open dispute" variant="danger" className="mt-3">
            <label className="label" htmlFor="reason">What happened?</label>
            <textarea className="input" id="reason" name="reason" minLength={5} maxLength={1000} required />
            <p className="text-xs text-muted">Funds stay frozen until {`Detour Ops`} decides (max 72h).</p>
          </ActionForm>
        </details>
      )}

      {/* ------------------------------------------------ reviews */}
      {task.status === "completed" && party && (
        <Section title="Reviews">
          {!myReview ? (
            <ActionForm action={reviewAction.bind(null, id)} submitLabel="Submit review" className="card">
              <label className="label" htmlFor="rating">Rate {isRequester ? "your worker" : "your requester"}</label>
              <select className="input" id="rating" name="rating" defaultValue="5">{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{"★".repeat(n)} ({n})</option>)}</select>
              <textarea className="input" name="comment" maxLength={500} placeholder="Optional comment" />
            </ActionForm>
          ) : <p className="rounded-xl bg-canvas p-3 text-sm">You left {myReview.rating}★.</p>}
          {reviewsRevealed ? (
            <ul className="mt-2 space-y-2">{reviews.map((r) => <li key={r.reviewer_id} className="card text-sm">{r.rating}★ for the {r.reviewee_role}{r.comment ? `: ${r.comment}` : ""}</li>)}</ul>
          ) : <p className="muted mt-2">Reviews stay hidden until both of you submit or 72h pass.</p>}
        </Section>
      )}

      {/* ------------------------------------------------ cancel */}
      {party && ["open", "negotiating", "agreed"].includes(task.status) && !payment?.pending_action && (isRequester || approved) && (
        <div className="mt-6">
          <ActionButton action={cancelTaskAction.bind(null, id)} variant="danger"
            label={isRequester ? (funded ? "Cancel & refund fee" : "Cancel request") : "Cancel this job"} pendingLabel="Cancelling…"
            confirm={funded ? "Cancel before pickup? The escrowed fee is refunded to the requester." + (isWorker ? " This counts as a cancellation after acceptance on your profile." : "")
              : isWorker ? "Cancel this job? It counts as a cancellation after acceptance. No money has moved." : "Cancel this request? No money has moved."} />
        </div>
      )}

      {/* ------------------------------------------------ timeline */}
      <Section title="Timeline">
        <ol className="card space-y-3">
          {events.map((e) => (
            <li key={e.id} className="flex gap-3 text-sm">
              <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand" />
              <div><p>{e.message}</p><p className="text-xs text-muted">{fmtDateTime(e.created_at)}{e.data?.txHash ? " · " : ""}{e.data?.txHash && <TxLink hash={e.data.txHash} chainId={payment?.chain_id ?? null} />}</p></div>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}
