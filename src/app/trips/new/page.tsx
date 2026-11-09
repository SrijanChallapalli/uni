import { ActionForm } from "@/components/ActionButton";
import { pageProfile } from "@/lib/auth";
import { MODE_LABEL, STORES, ZONES } from "@/lib/locations";
import { formatUsd } from "@/lib/money";
import { toCampusLocal } from "@/lib/time";
import { createTripAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function NewTrip() {
  const { profile } = await pageProfile();
  const round = (ms: number) => new Date(Math.ceil(ms / (15 * 60000)) * 15 * 60000);
  const depart = round(Date.now() + 30 * 60000);
  return (
    <div>
      <h1 className="text-2xl font-bold">Post a trip</h1>
      <p className="muted mt-1">Tell your agent about a store run you&apos;re already making. It only takes errands that fit your limits.</p>
      <ActionForm action={createTripAction} submitLabel="Post trip" pendingLabel="Posting…" className="mt-4">
        <div className="card space-y-3">
          <div><label className="label" htmlFor="store_id">Going to</label>
            <select className="input" id="store_id" name="store_id" required defaultValue="">
              <option value="" disabled>Choose a store</option>{STORES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label" htmlFor="origin_zone">Leaving from</label>
              <select className="input" id="origin_zone" name="origin_zone" defaultValue={profile.home_zone}>{ZONES.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select></div>
            <div><label className="label" htmlFor="return_zone">Heading back to</label>
              <select className="input" id="return_zone" name="return_zone" defaultValue={profile.home_zone}>{ZONES.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select></div>
            <div><label className="label" htmlFor="depart_at">Leaving at</label>
              <input className="input" id="depart_at" name="depart_at" type="datetime-local" required defaultValue={toCampusLocal(depart)} /></div>
            <div><label className="label" htmlFor="return_by">Back by</label>
              <input className="input" id="return_by" name="return_by" type="datetime-local" required defaultValue={toCampusLocal(new Date(depart.getTime() + 2 * 3600_000))} /></div>
            <div><label className="label" htmlFor="transport">Getting there by</label>
              <select className="input" id="transport" name="transport" defaultValue={profile.transport}>{Object.entries(MODE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div><label className="label" htmlFor="capacity">Room for</label>
              <select className="input" id="capacity" name="capacity" defaultValue={profile.capacity}>
                <option value="small">Small package</option><option value="medium">Medium package</option><option value="large">Large package</option>
              </select></div>
          </div>
          <div><label className="label" htmlFor="notes">Note (private)</label><input className="input" id="notes" name="notes" maxLength={280} /></div>
          <label className="flex items-start gap-2 rounded-lg bg-canvas p-3 text-sm">
            <input type="checkbox" name="auto_accept" defaultChecked className="mt-1" />
            <span>Let my agent accept jobs on this trip that pay at least {formatUsd(profile.min_fee_units)} and add at most {profile.max_detour_min} min. Otherwise it asks me first.</span>
          </label>
          <p className="text-xs text-muted">One errand per trip for now. Your trip details are never shown to requesters, only the extra time and timing for their errand.</p>
        </div>
      </ActionForm>
    </div>
  );
}
