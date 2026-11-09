"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { parseRequest, type ParseResult } from "@/lib/agents/requester";
import { AuthError, DEMO_COOKIE, demoMode, getViewer, requireProfile, signDemo } from "@/lib/auth";
import { one } from "@/lib/db";
import { dollarsToUnits } from "@/lib/money";
import { resetDemo } from "@/lib/seed";
import { approveAgreement, declineAgreement, editTerms, selectOffer } from "@/lib/services/agreements";
import { handleAgentMessage } from "@/lib/services/assistant";
import { afterApproval, applyWorkerMandate } from "@/lib/services/autopilot";
import { UserError } from "@/lib/services/common";
import {
  authorizeRelease, cancelTask, cancelTrip, createTask, createTrip, fundEscrow, markPickedUp, openDispute,
  resolveDispute, saveProfile, submitReview, verifyHandoff,
} from "@/lib/services/lifecycle";
import { runMatching } from "@/lib/services/matching";
import { supabaseConfigured, supabaseServer } from "@/lib/supabase";
import { fromCampusLocal } from "@/lib/time";

export type ActionState = { error?: string; ok?: string } | null;

async function run(fn: () => Promise<string | void>, paths: string[] = []): Promise<ActionState> {
  try {
    const ok = (await fn()) || "Done.";
    paths.forEach((p) => revalidatePath(p));
    return { ok };
  } catch (e) {
    if (e instanceof UserError || e instanceof AuthError) return { error: e.message };
    if (e && typeof e === "object" && "issues" in e) {
      const issues = (e as { issues: { message: string; path: (string | number)[] }[] }).issues;
      return { error: issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
    }
    if ((e as { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) throw e;
    console.error("[action]", e);
    return { error: "Something went wrong. Nothing was charged. Please try again." };
  }
}

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};
const req = (f: FormData, k: string, label: string) => {
  const v = str(f, k);
  if (v === null) throw new UserError(`${label} is required.`);
  return v;
};
const money = (f: FormData, k: string, label: string) => {
  try { return dollarsToUnits(req(f, k, label)); } catch (e) { throw e instanceof UserError ? e : new UserError(`${label}: enter a dollar amount like 5 or 5.50`); }
};
const when = (f: FormData, k: string, label: string) => {
  try { return fromCampusLocal(req(f, k, label)); } catch (e) { throw e instanceof UserError ? e : new UserError(`${label}: invalid date/time`); }
};

// ------------------------------------------------------------------ auth
export async function signInWithEmail(_: ActionState, f: FormData): Promise<ActionState> {
  return run(async () => {
    if (!supabaseConfigured()) throw new UserError("Email sign-in isn't configured on this deployment.");
    const email = req(f, "email", "Email").toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new UserError("Enter a valid email.");
    const sb = await supabaseServer();
    const origin = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: `${origin}/auth/callback` } });
    if (error) throw new UserError(`Couldn't send the sign-in link: ${error.message}`);
    return `Check ${email} for a sign-in link.${email.endsWith("@purdue.edu") ? "" : " Note: only confirmed @purdue.edu emails get the verified-student badge."}`;
  });
}

export async function signOut() {
  const store = await cookies();
  store.delete(DEMO_COOKIE);
  if (supabaseConfigured()) await (await supabaseServer()).auth.signOut();
  redirect("/");
}

export async function selectDemoPersona(profileId: string) {
  if (!demoMode()) throw new Error("Demo mode is disabled.");
  const p = await one<{ id: string }>("select id from profiles where id = $1 and is_demo and auth_user_id is null", [profileId]);
  if (!p) throw new Error("Unknown demo persona.");
  const store = await cookies();
  store.set(DEMO_COOKIE, signDemo(p.id), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 8 });
  redirect("/dashboard");
}

/** Demo-only: switch persona and stay on the same page (relative paths only, no open redirect). */
export async function switchDemoPersona(f: FormData) {
  if (!demoMode()) throw new Error("Demo mode is disabled.");
  const id = String(f.get("profile_id") ?? "");
  const back = String(f.get("return_to") ?? "/dashboard");
  const p = await one<{ id: string }>("select id from profiles where id = $1 and is_demo and auth_user_id is null", [id]);
  if (!p) throw new Error("Unknown demo persona.");
  const store = await cookies();
  store.set(DEMO_COOKIE, signDemo(p.id), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 8 });
  redirect(/^\/(?![/\\])[\w\-/]*$/.test(back) ? back : "/dashboard");
}

export async function resetDemoData(_: ActionState): Promise<ActionState> {
  return run(async () => {
    if (!demoMode()) throw new UserError("Reset is only available in demo mode.");
    await resetDemo();
    return "Demo data reset.";
  }, ["/", "/dashboard"]);
}

// ------------------------------------------------------------------ profile
export async function saveProfileAction(_: ActionState, f: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await getViewer();
    if (!v) throw new AuthError("Please sign in.");
    if (v.profile?.is_demo) throw new UserError("Demo personas can't be edited. Use Reset demo to restore them.");
    const days = f.getAll("avail_day").map(String);
    const starts = f.getAll("avail_start").map(String);
    const ends = f.getAll("avail_end").map(String);
    const availability = days.map((day, i) => ({ day, start: starts[i], end: ends[i] })).filter((a) => a.day && a.start && a.end);
    await saveProfile({ authUserId: v.authUserId, profileId: v.profile?.id ?? null }, {
      display_name: req(f, "display_name", "Display name"),
      home_zone: req(f, "home_zone", "Campus area"),
      transport: req(f, "transport", "Transportation") as "walk",
      capacity: req(f, "capacity", "Carrying capacity") as "small",
      min_fee_units: money(f, "min_fee", "Minimum fee"),
      max_detour_min: Number(req(f, "max_detour_min", "Max extra minutes")),
      default_budget_units: money(f, "default_budget", "Default budget"),
      default_deadline_buffer_min: Number(str(f, "deadline_buffer") ?? 60),
      availability,
      payout_address: str(f, "payout_address"),
    });
    redirect("/dashboard");
  });
}

// ------------------------------------------------------------------ requests & trips
export async function parseRequestAction(text: string): Promise<ParseResult | { error: string }> {
  try {
    const p = await requireProfile();
    if (!text.trim()) return { error: "Describe your errand first." };
    return await parseRequest(text, new Date(), { maxFeeUnits: p.default_budget_units });
  } catch (e) {
    return { error: e instanceof AuthError ? e.message : "Couldn't read that request. Fill in the form instead." };
  }
}

export async function createTaskAction(_: ActionState, f: FormData): Promise<ActionState> {
  return run(async () => {
    const p = await requireProfile();
    if (str(f, "confirm_details") !== "on") throw new UserError("Please confirm the details are correct.");
    const id = await createTask(p.id, {
      store_id: req(f, "store_id", "Store"),
      delivery_zone: req(f, "delivery_zone", "Delivery area"),
      delivery_detail: str(f, "delivery_detail"),
      order_reference: str(f, "order_reference"),
      pickup_window_start: when(f, "pickup_window_start", "Pickup window start"),
      pickup_window_end: when(f, "pickup_window_end", "Pickup window end"),
      delivery_deadline: when(f, "delivery_deadline", "Delivery deadline"),
      package_size: req(f, "package_size", "Package size") as "small",
      prepaid_confirmed: (str(f, "prepaid") === "on") as true,
      offered_fee_units: money(f, "offered_fee", "Offered fee"),
      max_fee_units: money(f, "max_fee", "Maximum fee"),
      instructions: str(f, "instructions"),
      raw_text: str(f, "raw_text"),
    });
    redirect(`/tasks/${id}`);
  });
}

export async function createTripAction(_: ActionState, f: FormData): Promise<ActionState> {
  return run(async () => {
    const p = await requireProfile();
    await createTrip(p.id, {
      origin_zone: req(f, "origin_zone", "Starting area"),
      store_id: req(f, "store_id", "Store"),
      return_zone: req(f, "return_zone", "Return area"),
      depart_at: when(f, "depart_at", "Departure"),
      return_by: when(f, "return_by", "Return by"),
      transport: req(f, "transport", "Transportation") as "walk",
      capacity: req(f, "capacity", "Capacity") as "small",
      notes: str(f, "notes"),
      auto_accept: str(f, "auto_accept") === "on",
    });
    redirect("/jobs?trip=posted");
  });
}

export async function cancelTripAction(tripId: string, _: ActionState): Promise<ActionState> {
  return run(async () => { await cancelTrip((await requireProfile()).id, tripId); return "Trip cancelled."; }, ["/jobs"]);
}

// ------------------------------------------------------------------ matching & agreements
export async function runMatchingAction(taskId: string, _: ActionState): Promise<ActionState> {
  return run(async () => {
    const r = await runMatching(taskId, (await requireProfile()).id);
    return r.feasible ? `Found ${r.feasible} feasible worker(s).` : "No feasible workers yet.";
  }, [`/tasks/${taskId}`]);
}

export async function selectOfferAction(taskId: string, offerId: string, _: ActionState): Promise<ActionState> {
  return run(async () => {
    const agId = await selectOffer(offerId, (await requireProfile()).id);
    const m = await applyWorkerMandate(agId);
    return m.fullyApproved ? "Approved. The worker's agent accepted under their standing instruction. Fund escrow to start." : "Terms approved and sent to the worker.";
  }, [`/tasks/${taskId}`]);
}

export async function approveAction(taskId: string, agreementId: string, version: number, _: ActionState): Promise<ActionState> {
  return run(async () => {
    const r = await approveAgreement(agreementId, version, (await requireProfile()).id);
    const funded = await afterApproval(taskId, r.fullyApproved);
    return r.fullyApproved ? `Both approved. Job assigned.${funded ? " The requester's agent funded escrow." : ""}` : "Approved. Waiting for the other person.";
  }, [`/tasks/${taskId}`, "/jobs"]);
}

export async function declineAction(taskId: string, agreementId: string, _: ActionState): Promise<ActionState> {
  return run(async () => { await declineAgreement(agreementId, (await requireProfile()).id); return "Declined."; }, [`/tasks/${taskId}`, "/jobs"]);
}

export async function editTermsAction(taskId: string, agreementId: string, _: ActionState, f: FormData): Promise<ActionState> {
  return run(async () => {
    const v = await editTerms(agreementId, (await requireProfile()).id, {
      feeUnits: money(f, "fee", "Fee"),
      deliveryDeadline: when(f, "delivery_deadline", "Deadline").toISOString(),
    });
    return `Proposed version ${v}. The other person must approve it.`;
  }, [`/tasks/${taskId}`]);
}

// ------------------------------------------------------------------ execution
export async function fundAction(taskId: string, _: ActionState): Promise<ActionState> {
  return run(async () => {
    const p = await fundEscrow(taskId, (await requireProfile()).id);
    return p.status === "funded" ? "Escrow funded." : "Funding submitted — waiting for on-chain confirmation.";
  }, [`/tasks/${taskId}`]);
}

export async function pickedUpAction(taskId: string, _: ActionState): Promise<ActionState> {
  return run(async () => { await markPickedUp(taskId, (await requireProfile()).id); return "Marked as picked up."; }, [`/tasks/${taskId}`]);
}

export async function verifyHandoffAction(taskId: string, _: ActionState, f: FormData): Promise<ActionState> {
  try {
    const p = await requireProfile();
    const r = await verifyHandoff(taskId, p.id, String(f.get("code") ?? ""));
    revalidatePath(`/tasks/${taskId}`);
    return r.ok ? { ok: r.message } : { error: r.message };
  } catch (e) {
    return { error: e instanceof UserError || e instanceof AuthError ? e.message : "Couldn't verify the code." };
  }
}

export async function releaseAction(taskId: string, _: ActionState): Promise<ActionState> {
  return run(async () => {
    const p = await authorizeRelease(taskId, (await requireProfile()).id);
    return p.status === "released" ? "Payment released to the worker." : "Release submitted — waiting for confirmation.";
  }, [`/tasks/${taskId}`]);
}

export async function cancelTaskAction(taskId: string, _: ActionState): Promise<ActionState> {
  return run(async () => cancelTask(taskId, (await requireProfile()).id), [`/tasks/${taskId}`, "/dashboard", "/jobs"]);
}

export async function disputeAction(taskId: string, _: ActionState, f: FormData): Promise<ActionState> {
  return run(async () => { await openDispute(taskId, (await requireProfile()).id, req(f, "reason", "Reason")); return "Dispute opened. Funds are frozen."; }, [`/tasks/${taskId}`]);
}

export async function resolveAction(taskId: string, toWorker: boolean, _: ActionState, f: FormData): Promise<ActionState> {
  return run(async () => {
    await resolveDispute(taskId, (await requireProfile()).id, toWorker, str(f, "note") ?? "");
    return toWorker ? "Resolved: paid to worker." : "Resolved: refunded to requester.";
  }, ["/resolver", `/tasks/${taskId}`]);
}

export async function reviewAction(taskId: string, _: ActionState, f: FormData): Promise<ActionState> {
  return run(async () => {
    await submitReview(taskId, (await requireProfile()).id, Number(req(f, "rating", "Rating")), str(f, "comment"));
    return "Thanks! Reviews are revealed once both of you submit (or after 72h).";
  }, [`/tasks/${taskId}`]);
}

export async function markNotificationsRead() {
  const p = await requireProfile();
  await one("update notifications set read_at = now() where profile_id = $1 and read_at is null", [p.id]);
  revalidatePath("/dashboard");
}

// ------------------------------------------------------------------ personal agent
export async function agentMessageAction(taskId: string | null, _: ActionState, f: FormData): Promise<ActionState> {
  return run(async () => {
    const p = await requireProfile();
    await handleAgentMessage(p, str(f, "chip") ?? str(f, "text") ?? "", taskId);
    return " ";
  }, ["/dashboard", "/jobs", ...(taskId ? [`/tasks/${taskId}`] : [])]);
}
