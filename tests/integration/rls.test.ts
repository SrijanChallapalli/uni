import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { one, q } from "@/lib/db";
import { createTask } from "@/lib/services/lifecycle";
import { cleanup, clock, endPool, taskInput } from "./helpers";

// Database access controls, exercised with real Supabase Auth sessions and the public anon key.
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const stamp = Date.now();
const users = { a: `rls-a-${stamp}@purdue.edu`, b: `rls-b-${stamp}@example.com` };
const ids: Record<string, { auth: string; profile: string }> = {};

async function session(email: string) {
  const c = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: "test-password-123" });
  if (error) throw error;
  return c;
}

beforeAll(async () => {
  await cleanup();
  for (const [k, email] of Object.entries(users)) {
    const { data, error } = await admin.auth.admin.createUser({ email, password: "test-password-123", email_confirm: true });
    if (error) throw error;
    const p = await one<{ id: string }>(
      `insert into profiles (auth_user_id, display_name, home_zone, transport, capacity, onboarded) values ($1,$2,'pmu','walk','small',true) returning id`,
      [data.user.id, `test:${k}`]);
    ids[k] = { auth: data.user.id, profile: p!.id };
  }
  await createTask(ids.a.profile, taskInput(clock()));
  await createTask(ids.b.profile, taskInput(clock()));
});

afterAll(async () => {
  await cleanup();
  for (const v of Object.values(ids)) await admin.auth.admin.deleteUser(v.auth);
  await endPool();
});

describe("row-level security", () => {
  it("anonymous clients read nothing", async () => {
    const anon = createClient(URL, ANON, { auth: { persistSession: false } });
    const { data } = await anon.from("tasks").select("id");
    expect(data ?? []).toHaveLength(0);
  });

  it("signed-in users see only their own rows", async () => {
    const a = await session(users.a);
    const { data: tasks, error } = await a.from("tasks").select("id, requester_id");
    expect(error).toBeNull();
    expect(tasks!.length).toBe(1);
    expect(tasks![0].requester_id).toBe(ids.a.profile);
    const { data: profiles } = await a.from("profiles").select("id");
    expect(profiles!.map((p) => p.id)).toEqual([ids.a.profile]);
  });

  it("clients cannot write directly or read server-only tables", async () => {
    const b = await session(users.b);
    const ins = await b.from("tasks").insert({ requester_id: ids.b.profile, store_id: "target_wl" });
    expect(ins.error).not.toBeNull();
    const upd = await b.from("profiles").update({ campus_email_verified_at: new Date().toISOString() }).eq("id", ids.b.profile).select();
    expect(upd.error !== null || (upd.data ?? []).length === 0).toBe(true);
    const codes = await b.from("handoff_codes").select("*");
    expect(codes.data ?? []).toHaveLength(0);
    const p = await one<{ campus_email_verified_at: Date | null }>("select campus_email_verified_at from profiles where id = $1", [ids.b.profile]);
    expect(p!.campus_email_verified_at).toBeNull(); // typed/forged input never verifies
  });

  it("server-side verification only trusts confirmed campus-domain emails", async () => {
    const { data } = await admin.auth.admin.getUserById(ids.a.auth);
    expect(data.user?.email_confirmed_at).toBeTruthy();
    expect(data.user?.email?.endsWith("@purdue.edu")).toBe(true);
    const rows = await q("select 1 from profiles where id = $1 and campus_email_verified_at is null", [ids.b.profile]);
    expect(rows).toHaveLength(1);
  });
});
