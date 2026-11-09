import { one, pool, q } from "@/lib/db";

export const PREFIX = "test:";
const $ = (d: number) => Math.round(d * 100) * 10_000;

export async function cleanup() {
  await q(`delete from tasks where requester_id in (select id from profiles where display_name like 'test:%')`);
  await q(`delete from profiles where display_name like 'test:%'`);
}

export async function mkProfile(name: string, over: Partial<{ minFee: number; detour: number; transport: string; capacity: string; zone: string; resolver: boolean; payout: string }> = {}) {
  const r = await one<{ id: string }>(
    `insert into profiles (display_name, home_zone, transport, capacity, min_fee_units, max_detour_min, onboarded, is_resolver, payout_address)
     values ($1,$2,$3,$4,$5,$6,true,$7,$8) returning id`,
    [PREFIX + name, over.zone ?? "hillenbrand", over.transport ?? "car", over.capacity ?? "large", over.minFee ?? $(3), over.detour ?? 30, over.resolver ?? false, over.payout ?? null]);
  return r!.id;
}

/** Times relative to a base "5 p.m." in the future so trips are never in the past. */
export function clock() {
  const base = new Date(Math.ceil((Date.now() + 2 * 86400_000) / 3600_000) * 3600_000);
  return (m: number) => new Date(base.getTime() + m * 60000);
}

export async function mkTrip(workerId: string, at: (m: number) => Date, over: Partial<{ origin: string; ret: string; depart: number; transport: string; capacity: string; store: string }> = {}) {
  const r = await one<{ id: string }>(
    `insert into trips (worker_id, origin_zone, store_id, return_zone, depart_at, return_by, transport, capacity)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [workerId, over.origin ?? "cary_quad", over.store ?? "target_wl", over.ret ?? "hillenbrand", at(over.depart ?? -5), at(180), over.transport ?? "car", over.capacity ?? "large"]);
  return r!.id;
}

export const taskInput = (at: (m: number) => Date, over: Record<string, unknown> = {}) => ({
  store_id: "target_wl", delivery_zone: "earhart_windsor", delivery_detail: "Windsor lobby", order_reference: "TGT-1",
  pickup_window_start: at(0), pickup_window_end: at(75), delivery_deadline: at(120), package_size: "small" as const,
  prepaid_confirmed: true as const, offered_fee_units: $(5), max_fee_units: $(7), instructions: null, raw_text: null, ...over,
});

export async function endPool() {
  await pool().end();
}
