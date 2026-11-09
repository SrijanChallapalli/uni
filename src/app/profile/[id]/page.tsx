import { notFound } from "next/navigation";
import { Section } from "@/components/ui";
import { pageProfile } from "@/lib/auth";
import { one, q } from "@/lib/db";
import { MODE_LABEL, placeName } from "@/lib/locations";
import type { Profile, Reputation } from "@/lib/types";

export const dynamic = "force-dynamic";

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return <div className="rounded-xl bg-canvas p-3"><p className="text-xs text-muted">{label}</p><p className="text-xl font-bold">{value}</p>{sub && <p className="text-xs text-muted">{sub}</p>}</div>;
}

export default async function ProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { profile: me } = await pageProfile();
  const p = await one<Profile>("select * from profiles where id = $1", [id]);
  if (!p || p.is_demo !== me.is_demo) notFound();
  const r = await one<Reputation>("select * from reputation where profile_id = $1", [id]);
  const reviews = await q<{ rating: number; comment: string | null; reviewee_role: string; created_at: Date }>(
    `select r.rating, r.comment, r.reviewee_role, r.created_at from reviews r join tasks t on t.id = r.task_id
     where r.reviewee_id = $1 and ((select count(*) from reviews r2 where r2.task_id = r.task_id) >= 2 or t.completed_at < now() - interval '72 hours')
     order by r.created_at desc limit 10`, [id]);
  const isMe = me.id === p.id;
  const onTime = r && r.completed_as_worker ? Math.round((r.on_time_deliveries / r.completed_as_worker) * 100) : null;

  return (
    <div>
      <h1 className="text-2xl font-bold">{p.display_name}</h1>
      <p className="muted">
        {p.campus_email_verified_at ? <span className="font-semibold text-brand">✓ Verified Purdue email</span> : p.is_demo ? "Fictional demo persona · not verified" : "Campus email not verified"}
        {" · "}{placeName(p.home_zone)} · {MODE_LABEL[p.transport]}
      </p>
      {r && r.completed_as_worker === 0 && r.completed_as_requester === 0 && (
        <p className="mt-2 rounded-lg bg-info-soft px-3 py-2 text-sm">New here — no history yet. New workers can take small packages.</p>
      )}
      <Section title="As a worker">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Completed jobs" value={r?.completed_as_worker ?? 0} />
          <Stat label="On time" value={onTime === null ? "—" : `${onTime}%`} sub={r ? `${r.on_time_deliveries} of ${r.completed_as_worker}` : undefined} />
          <Stat label="Rating" value={r?.worker_avg_rating ? `${Number(r.worker_avg_rating).toFixed(1)}★` : "—"} sub={`${r?.worker_review_count ?? 0} review(s)`} />
          <Stat label="Cancelled after accepting" value={r?.cancellations_after_acceptance ?? 0} />
        </div>
      </Section>
      <Section title="As a requester">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Completed requests" value={r?.completed_as_requester ?? 0} />
          <Stat label="Rating" value={r?.requester_avg_rating ? `${Number(r.requester_avg_rating).toFixed(1)}★` : "—"} sub={`${r?.requester_review_count ?? 0} review(s)`} />
          <Stat label="Avg. time to confirm handoff" value={r?.avg_confirm_minutes != null ? `${Math.round(Number(r.avg_confirm_minutes))} min` : "—"} />
        </div>
      </Section>
      <Section title="Recent reviews">
        {reviews.length === 0 ? <p className="muted">No revealed reviews yet.</p> : (
          <ul className="space-y-2">{reviews.map((rv, i) => <li key={i} className="card text-sm">{"★".repeat(rv.rating)} <span className="text-muted">as {rv.reviewee_role}</span>{rv.comment && <p>{rv.comment}</p>}</li>)}</ul>
        )}
        <p className="mt-2 text-xs text-muted">Reviews are revealed after both sides submit or 72h pass. Disputes don&apos;t affect ratings by themselves.</p>
      </Section>
      {isMe && !p.is_demo && <p className="mt-4 text-sm"><a href="/onboarding" className="text-brand underline">Edit agent preferences</a></p>}
    </div>
  );
}
