import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { one } from "./db";
import { supabaseConfigured, supabaseServer } from "./supabase";
import type { Profile } from "./types";

export const DEMO_COOKIE = "detour_demo";
export const CAMPUS_DOMAIN = "purdue.edu";

export function demoMode(): boolean {
  return process.env.DEMO_MODE === "true";
}

function demoSecret(): string {
  const s = process.env.DEMO_COOKIE_SECRET;
  if (!s || s.length < 16) throw new Error("DEMO_COOKIE_SECRET must be set (16+ chars) when DEMO_MODE=true");
  return s;
}

export function signDemo(profileId: string): string {
  return `${profileId}.${createHmac("sha256", demoSecret()).update(`demo:${profileId}`).digest("hex")}`;
}

export function verifyDemo(value: string | undefined): string | null {
  if (!value) return null;
  const [id, sig] = value.split(".");
  if (!id || !sig) return null;
  const expected = Buffer.from(createHmac("sha256", demoSecret()).update(`demo:${id}`).digest("hex"));
  const got = Buffer.from(sig);
  return expected.length === got.length && timingSafeEqual(expected, got) ? id : null;
}

export interface Viewer {
  profile: Profile | null; // null = signed in but not onboarded
  authUserId: string | null;
  email: string | null;
  emailVerifiedCampus: boolean;
  via: "supabase" | "demo";
}

/**
 * Resolve the current user. A real Supabase session always wins; the demo cookie is honored only
 * when DEMO_MODE=true and only maps to profiles flagged is_demo (which can never have an auth user).
 */
export async function getViewer(): Promise<Viewer | null> {
  if (supabaseConfigured()) {
    const sb = await supabaseServer();
    const { data } = await sb.auth.getUser();
    const user = data.user;
    if (user) {
      const email = user.email ?? null;
      const verified = Boolean(user.email_confirmed_at && email && email.toLowerCase().endsWith(`@${CAMPUS_DOMAIN}`));
      const profile = await one<Profile>("select * from profiles where auth_user_id = $1", [user.id]);
      if (profile && verified && !profile.campus_email_verified_at) {
        // Verification comes only from the auth provider's confirmed email, never from typed text.
        await one("update profiles set campus_email = $2, campus_email_verified_at = now() where id = $1", [profile.id, email]);
        profile.campus_email = email;
        profile.campus_email_verified_at = new Date();
      }
      return { profile, authUserId: user.id, email, emailVerifiedCampus: verified, via: "supabase" };
    }
  }
  if (demoMode()) {
    const store = await cookies();
    const id = verifyDemo(store.get(DEMO_COOKIE)?.value);
    if (id) {
      const profile = await one<Profile>("select * from profiles where id = $1 and is_demo = true and auth_user_id is null", [id]);
      if (profile) return { profile, authUserId: null, email: null, emailVerifiedCampus: false, via: "demo" };
    }
  }
  return null;
}

export class AuthError extends Error {}

/** For server actions and route handlers: require an onboarded profile. */
export async function requireProfile(): Promise<Profile> {
  const v = await getViewer();
  if (!v?.profile) throw new AuthError("Please sign in.");
  return v.profile;
}

/** For pages: redirect instead of throwing. */
export async function pageProfile(): Promise<{ profile: Profile; viewer: Viewer }> {
  const v = await getViewer();
  if (!v) redirect("/");
  if (!v.profile || !v.profile.onboarded) redirect("/onboarding");
  return { profile: v.profile, viewer: v };
}
