// Demo data. Every persona is fictional and flagged is_demo; demo personas only match each other.
import { randomUUID } from "node:crypto";
import { one, q, tx } from "./db";
import { escrowIdFor } from "./escrow/abi";
import { campusAt, toCampusLocal } from "./time";

const $ = (d: number) => Math.round(d * 100) * 10_000;

export const DEMO_PERSONAS = {
  riley: { name: "Riley (demo requester)", blurb: "Needs a prepaid Target order before 7 p.m." },
  maya: { name: "Maya (demo worker)", blurb: "Driving to Target, heading home to Windsor. Her agent auto-accepts jobs that fit. 6 completed jobs." },
  sam: { name: "Sam (demo worker)", blurb: "Biking to Target too late to meet the deadline." },
  nia: { name: "Nia (demo worker)", blurb: "New worker taking the bus to Target. Wants at least $6.50, so her agent negotiates." },
  theo: { name: "Theo (demo requester)", blurb: "Has a cancelled request and an open dispute." },
  ops: { name: "Detour Ops (demo resolver)", blurb: "Disclosed centralized resolver for disputes." },
} as const;

export async function resetDemo(now = new Date()): Promise<Record<string, string>> {
  return tx(async (c) => {
    await q("delete from tasks where requester_id in (select id from profiles where is_demo)", [], c);
    await q("delete from profiles where is_demo", [], c);

    const ids: Record<string, string> = {};
    const mk = async (key: keyof typeof DEMO_PERSONAS, p: Record<string, unknown>) => {
      const row = await one<{ id: string }>(
        `insert into profiles (is_demo, is_resolver, display_name, home_zone, transport, capacity, min_fee_units, max_detour_min,
           default_budget_units, default_deadline_buffer_min, availability, payout_address, onboarded)
         values (true,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true) returning id`,
        [p.resolver ?? false, DEMO_PERSONAS[key].name, p.zone, p.transport, p.capacity, p.minFee, p.detour, p.budget ?? $(8), 60,
          JSON.stringify(p.availability ?? [{ day: "daily", start: "16:00", end: "21:00" }]), p.payout ?? null], c);
      ids[key] = row!.id;
    };
    await mk("riley", { zone: "earhart_windsor", transport: "walk", capacity: "small", minFee: $(3), detour: 10, budget: $(7) });
    await mk("maya", { zone: "earhart_windsor", transport: "car", capacity: "large", minFee: $(3), detour: 30, payout: "0x000000000000000000000000000000000000a11a" });
    await mk("sam", { zone: "harrison", transport: "bike", capacity: "medium", minFee: $(2.5), detour: 25, payout: "0x000000000000000000000000000000000000005a" });
    await mk("nia", { zone: "harrison", transport: "bus", capacity: "medium", minFee: $(6.5), detour: 45, payout: "0x000000000000000000000000000000000000041a" });
    await mk("theo", { zone: "cary_quad", transport: "walk", capacity: "small", minFee: $(3), detour: 10 });
    await mk("ops", { zone: "pmu", transport: "walk", capacity: "small", minFee: 0, detour: 0, resolver: true });

    // Demo day: today if there's time before the 5 p.m. pickup window, otherwise tomorrow.
    const local = toCampusLocal(now);
    const day = Number(local.slice(11, 13)) < 15 ? 0 : 1;
    const at = (h: number, m: number, d = day) => campusAt(h, m, d, now);

    // ---- history for Maya (6 completed, on-time, reviewed) so reputation is real data, not a hardcoded badge
    const priya = await one<{ id: string }>(
      `insert into profiles (is_demo, display_name, home_zone, transport, capacity, onboarded) values (true,'Priya (demo requester)','cary_quad','walk','small',true) returning id`, [], c);
    for (let i = 1; i <= 6; i++) {
      const d = -i - 1;
      const trip = await one<{ id: string }>(
        `insert into trips (worker_id, origin_zone, store_id, return_zone, depart_at, return_by, transport, capacity, status)
         values ($1,'hillenbrand','target_wl','hillenbrand',$2,$3,'car','large','completed') returning id`, [ids.maya, at(16, 0, d), at(18, 0, d)], c);
      void trip;
      await q(
        `insert into tasks (requester_id, store_id, delivery_zone, pickup_window_start, pickup_window_end, delivery_deadline, package_size,
           prepaid_confirmed, offered_fee_units, max_fee_units, status, completed_at)
         values ($1,'target_wl','cary_quad',$2,$3,$4,'small',true,$5,$5,'completed',$6)`,
        [priya!.id, at(16, 0, d), at(17, 0, d), at(18, 30, d), $(5), at(17, 50, d)], c);
    }
    // Agreements need an offer row; create minimal ones for history.
    const hist = await q<{ id: string; trip_id: string; completed_at: Date; delivery_deadline: Date }>(
      `select t.id, tr.id as trip_id, t.completed_at, t.delivery_deadline from tasks t
       join trips tr on tr.worker_id = $1 and tr.depart_at::date = t.pickup_window_start::date
       where t.requester_id = $2`, [ids.maya, priya!.id], c);
    let r = 0;
    for (const h of hist) {
      const off = await one<{ id: string }>(
        `insert into offers (task_id, worker_id, trip_id, task_terms_version, decision, fee_units, effort_low_min, effort_high_min, trip_total_min, summary, agent_source, status, expires_at)
         values ($1,$2,$3,1,'accept',$4,8,20,40,'History record (seeded)','rules','selected',$5) returning id`, [h.id, ids.maya, h.trip_id, $(5), h.completed_at], c);
      const ag = await one<{ id: string }>(
        `insert into agreements (task_id, offer_id, requester_id, worker_id, trip_id, status) values ($1,$2,$3,$4,$5,'approved') returning id`,
        [h.id, off!.id, priya!.id, ids.maya, h.trip_id], c);
      await q(`insert into assignments (task_id, agreement_id, worker_id, trip_id, window_start, window_end, active) values ($1,$2,$3,$4,$5,$6,true)`,
        [h.id, ag!.id, ids.maya, h.trip_id, new Date(new Date(h.completed_at).getTime() - 3600_000), h.completed_at], c);
      const handoff = new Date(new Date(h.completed_at).getTime() - 10 * 60000);
      await q(`insert into task_events (task_id, actor_id, type, message, created_at) values ($1,$2,'handed_off','Handoff code verified (seeded history).',$3),
               ($1,$4,'release_authorized','Requester authorized release (seeded history).',$5)`,
        [h.id, ids.maya, handoff, priya!.id, new Date(handoff.getTime() + 6 * 60000)], c);
      const pid = randomUUID();
      await q(`insert into payments (id, task_id, agreement_id, mode, amount_units, status, escrow_id) values ($1,$2,$3,'simulated',$4,'released',$5)`,
        [pid, h.id, ag!.id, $(5), escrowIdFor(pid)], c);
      await q(`insert into reviews (task_id, reviewer_id, reviewee_id, reviewee_role, rating, comment) values ($1,$2,$3,'worker',$4,$5), ($1,$3,$2,'requester',5,null)`,
        [h.id, priya!.id, ids.maya, r++ === 2 ? 4 : 5, r === 1 ? "Fast and friendly." : null], c);
    }

    // ---- the live demo request and trips
    const riley = await one<{ id: string }>(
      `insert into tasks (requester_id, store_id, delivery_zone, delivery_detail, order_reference, pickup_window_start, pickup_window_end,
         delivery_deadline, package_size, prepaid_confirmed, offered_fee_units, max_fee_units, instructions, raw_text)
       values ($1,'target_wl','earhart_windsor','Windsor Halls front desk lobby','TGT-48213',$2,$3,$4,'small',true,$5,$6,
         'Drive Up / Order Pickup counter. Order is under "Riley D."',
         'Can someone grab my prepaid Target order (ready at 5) and bring it to Windsor before 7pm? Small bag, up to $7.') returning id`,
      [ids.riley, at(17, 0), at(18, 15), at(19, 0), $(5), $(7)], c);
    await q(`insert into task_events (task_id, actor_id, type, message) values ($1,$2,'created','Request posted with an opening offer of $5.00.')`, [riley!.id, ids.riley], c);
    const trip = (w: string, o: string, ret: string, h: number, m: number, mode: string, cap: string, notes: string, auto = false) =>
      q(`insert into trips (worker_id, origin_zone, store_id, return_zone, depart_at, return_by, transport, capacity, notes, auto_accept)
         values ($1,$2,'target_wl',$3,$4,$5,$6,$7,$8,$9)`, [w, o, ret, at(h, m), at(h + 2, m), mode, cap, notes, auto], c);
    await trip(ids.maya, "cary_quad", "earhart_windsor", 16, 55, "car", "large", "Weekly grocery run, heading home to Windsor", true);
    await trip(ids.sam, "harrison", "harrison", 18, 20, "bike", "medium", "Picking up a bike lock");
    await trip(ids.nia, "harrison", "harrison", 16, 40, "bus", "medium", "Route 4 bus, back by dinner");

    // Each person's agent opens the conversation with where things stand.
    const say = (who: string, task: string | null, body: string, suggest: string[]) =>
      q("insert into agent_messages (profile_id, task_id, role, body, data) values ($1,$2,'agent',$3,$4)", [who, task, body, JSON.stringify({ suggest })], c);
    await say(ids.riley, riley!.id, `Your Target → Windsor request is posted: opening at $5.00, max $7.00, deliver by 7 p.m. Say "find someone" and I'll negotiate with workers' agents.`, ["Find someone", "Status"]);
    await say(ids.maya, null, `Your Target run at 4:55 is posted. I'll accept errands that pay at least $3.00 and add at most 30 min, then tell you. Say "ask me first" to approve each one yourself.`, ["Status", "Ask me first"]);
    await say(ids.nia, null, `Your Target bus trip at 4:40 is posted. I'll negotiate for at least $6.50 and ask you before accepting anything.`, ["Status"]);

    // ---- Theo: a cancelled example (no money moved) and an open dispute (funds frozen in simulated escrow)
    const cancelled = await one<{ id: string }>(
      `insert into tasks (requester_id, store_id, delivery_zone, pickup_window_start, pickup_window_end, delivery_deadline, package_size,
         prepaid_confirmed, offered_fee_units, max_fee_units, status) values ($1,'cvs_state','cary_quad',$2,$3,$4,'small',true,$5,$5,'cancelled') returning id`,
      [ids.theo, at(12, 0, -1), at(13, 0, -1), at(14, 0, -1), $(4)], c);
    await q(`insert into task_events (task_id, actor_id, type, message) values ($1,$2,'created','Request posted with an opening offer of $4.00.'),
             ($1,$2,'cancelled','Requester cancelled the request before anyone was assigned. No money moved.')`, [cancelled!.id, ids.theo], c);

    const dTrip = await one<{ id: string }>(
      `insert into trips (worker_id, origin_zone, store_id, return_zone, depart_at, return_by, transport, capacity, status)
       values ($1,'harrison','walmart_laf','harrison',$2,$3,'bike','medium','completed') returning id`, [ids.sam, at(14, 0, -1), at(16, 0, -1)], c);
    const dTask = await one<{ id: string }>(
      `insert into tasks (requester_id, store_id, delivery_zone, pickup_window_start, pickup_window_end, delivery_deadline, package_size,
         prepaid_confirmed, offered_fee_units, max_fee_units, status) values ($1,'walmart_laf','cary_quad',$2,$3,$4,'medium',true,$5,$5,'disputed') returning id`,
      [ids.theo, at(14, 0, -1), at(15, 0, -1), at(16, 30, -1), $(6)], c);
    const dOff = await one<{ id: string }>(
      `insert into offers (task_id, worker_id, trip_id, task_terms_version, decision, fee_units, effort_low_min, effort_high_min, trip_total_min, summary, agent_source, status, expires_at)
       values ($1,$2,$3,1,'accept',$4,10,24,60,'Accept at $6.00 (seeded example).','rules','selected',$5) returning id`, [dTask!.id, ids.sam, dTrip!.id, $(6), at(14, 0, -1)], c);
    const dAg = await one<{ id: string }>(
      `insert into agreements (task_id, offer_id, requester_id, worker_id, trip_id, status) values ($1,$2,$3,$4,$5,'approved') returning id`,
      [dTask!.id, dOff!.id, ids.theo, ids.sam, dTrip!.id], c);
    await q(`insert into assignments (task_id, agreement_id, worker_id, trip_id, window_start, window_end) values ($1,$2,$3,$4,$5,$6)`,
      [dTask!.id, dAg!.id, ids.sam, dTrip!.id, at(14, 30, -1), at(16, 0, -1)], c);
    const dPay = randomUUID();
    await q(`insert into payments (id, task_id, agreement_id, mode, amount_units, status, escrow_id, refund_reason) values ($1,$2,$3,'simulated',$4,'disputed',$5,'dispute')`,
      [dPay, dTask!.id, dAg!.id, $(6), escrowIdFor(dPay)], c);
    await q(`insert into disputes (task_id, opened_by, reason, resolver_label, respond_by) values ($1,$2,$3,'Detour Ops (centralized resolver operated by the app team)',$4)`,
      [dTask!.id, ids.theo, "Handoff code was entered but the bag I received was missing one of two items.", new Date(now.getTime() + 60 * 3600_000)], c);
    await q(`insert into task_events (task_id, actor_id, type, message) values
       ($1,$2,'agreed','Both parties approved v1 at $6.00 (seeded example).'),
       ($1,null,'payment_funded','Escrow funded with $6.00 (simulated).'),
       ($1,$3,'handed_off','Handoff code verified. This confirms receipt — not contents.'),
       ($1,$2,'dispute_opened','Requester opened a dispute. Opening a dispute does not penalize either side.'),
       ($1,null,'payment_disputed','Escrow frozen for dispute (simulated).')`, [dTask!.id, ids.theo, ids.sam], c);

    return ids;
  });
}
