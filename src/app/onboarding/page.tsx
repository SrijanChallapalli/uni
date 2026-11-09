import { redirect } from "next/navigation";
import { ActionForm } from "@/components/ActionButton";
import { getViewer } from "@/lib/auth";
import { MODE_LABEL, ZONES } from "@/lib/locations";
import { unitsToDollarString } from "@/lib/money";
import { saveProfileAction } from "../actions";

export const dynamic = "force-dynamic";
const DAYS = ["daily", "weekdays", "weekends", "mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export default async function Onboarding() {
  const v = await getViewer();
  if (!v) redirect("/");
  const p = v.profile;
  if (p?.is_demo) redirect("/dashboard");
  const avail = [...(p?.availability ?? []), { day: "", start: "", end: "" }, { day: "", start: "", end: "" }].slice(0, 3);

  return (
    <div>
      <h1 className="text-2xl font-bold">{p ? "Agent preferences" : "Set up your agent"}</h1>
      <p className="muted mt-1">Your agent uses these to judge which errands fit your trips. It never commits you or spends money without your approval.</p>
      <div className="mt-3 rounded-xl bg-white p-3 text-sm">
        {v.emailVerifiedCampus
          ? <span className="font-semibold text-brand">✓ Verified Purdue email: {v.email}</span>
          : <span className="text-muted">Signed in as {v.email}. Not a confirmed @purdue.edu address, so there&apos;s no verified badge.</span>}
      </div>

      <ActionForm action={saveProfileAction} submitLabel="Save preferences" pendingLabel="Saving…" className="mt-4">
        <div className="card space-y-3">
          <h2 className="font-semibold">About you</h2>
          <div><label className="label" htmlFor="display_name">Display name</label>
            <input className="input" id="display_name" name="display_name" required maxLength={60} defaultValue={p?.display_name ?? ""} /></div>
          <div><label className="label">Campus</label><input className="input bg-canvas" value="Purdue University (West Lafayette)" disabled /></div>
          <div><label className="label" htmlFor="home_zone">Usual pickup / delivery area (approximate)</label>
            <select className="input" id="home_zone" name="home_zone" defaultValue={p?.home_zone ?? ""} required>
              <option value="" disabled>Choose an area</option>
              {ZONES.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
            <p className="mt-1 text-xs text-muted">Exact addresses are only shared with your assigned worker, per task.</p></div>
        </div>

        <div className="card space-y-3">
          <h2 className="font-semibold">When you run errands for others</h2>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label" htmlFor="transport">Transportation</label>
              <select className="input" id="transport" name="transport" defaultValue={p?.transport ?? "walk"}>
                {Object.entries(MODE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select></div>
            <div><label className="label" htmlFor="capacity">Carrying capacity</label>
              <select className="input" id="capacity" name="capacity" defaultValue={p?.capacity ?? "small"}>
                <option value="small">Small (backpack)</option><option value="medium">Medium (a bag)</option><option value="large">Large (car)</option>
              </select></div>
            <div><label className="label" htmlFor="min_fee">Minimum fee ($)</label>
              <input className="input" id="min_fee" name="min_fee" inputMode="decimal" required defaultValue={unitsToDollarString(p?.min_fee_units ?? 3_000_000)} /></div>
            <div><label className="label" htmlFor="max_detour_min">Max extra minutes</label>
              <input className="input" id="max_detour_min" name="max_detour_min" type="number" min={0} max={240} required defaultValue={p?.max_detour_min ?? 20} /></div>
          </div>
          <div>
            <p className="label">Usual availability</p>
            {avail.map((a, i) => (
              <div key={i} className="mb-2 grid grid-cols-3 gap-2">
                <select className="input" name="avail_day" defaultValue={a.day} aria-label="Day">
                  <option value="">—</option>{DAYS.map((d) => <option key={d}>{d}</option>)}
                </select>
                <input className="input" name="avail_start" type="time" defaultValue={a.start} aria-label="From" />
                <input className="input" name="avail_end" type="time" defaultValue={a.end} aria-label="To" />
              </div>
            ))}
            <p className="text-xs text-muted">Manual entry only. No calendar or location access. Post specific trips from the dashboard.</p>
          </div>
          <div><label className="label" htmlFor="payout_address">Testnet payout address (optional)</label>
            <input className="input font-mono text-sm" id="payout_address" name="payout_address" placeholder="0x…" pattern="^0x[0-9a-fA-F]{40}$" defaultValue={p?.payout_address ?? ""} />
            <p className="mt-1 text-xs text-muted">Needed only for real Arc Testnet escrow. Test funds only.</p></div>
        </div>

        <div className="card space-y-3">
          <h2 className="font-semibold">When you request errands</h2>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label" htmlFor="default_budget">Usual max fee ($)</label>
              <input className="input" id="default_budget" name="default_budget" inputMode="decimal" required defaultValue={unitsToDollarString(p?.default_budget_units ?? 8_000_000)} /></div>
            <div><label className="label" htmlFor="deadline_buffer">Deadline buffer (min)</label>
              <input className="input" id="deadline_buffer" name="deadline_buffer" type="number" min={0} max={1440} defaultValue={p?.default_deadline_buffer_min ?? 60} /></div>
          </div>
        </div>
      </ActionForm>
    </div>
  );
}
