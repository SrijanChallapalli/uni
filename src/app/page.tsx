import { redirect } from "next/navigation";
import { ActionButton, ActionForm } from "@/components/ActionButton";
import { demoMode, getViewer } from "@/lib/auth";
import { q } from "@/lib/db";
import { DEMO_PERSONAS } from "@/lib/seed";
import { supabaseConfigured } from "@/lib/supabase";
import { resetDemoData, selectDemoPersona, signInWithEmail } from "./actions";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ switch?: string }> }) {
  const viewer = await getViewer();
  const sp = await searchParams;
  if (viewer?.via === "supabase") redirect(viewer.profile?.onboarded ? "/dashboard" : "/onboarding");
  void sp;
  const personas = demoMode()
    ? await q<{ id: string; display_name: string }>("select id, display_name from profiles where is_demo and display_name = any($1) order by created_at",
        [Object.values(DEMO_PERSONAS).map((p) => p.name)]).catch(() => [])
    : [];
  const blurb = (name: string) => Object.values(DEMO_PERSONAS).find((p) => p.name === name)?.blurb;

  return (
    <div className="space-y-6">
      <section className="pt-6">
        <p className="text-sm font-semibold text-brand">For Purdue students · prepaid store pickups</p>
        <h1 className="mt-2 text-3xl font-bold leading-tight tracking-tight">Get your errands done.<br />Earn money from trips you&apos;re already taking.</h1>
        <p className="mt-3 text-muted">
          Your personal agent knows your trips, timing, capacity, and fees. It finds a student already heading to the store,
          proposes fair terms, and only commits when you both approve. The delivery fee sits in escrow until handoff.
        </p>
      </section>

      <section className="card">
        <h2 className="font-semibold">Sign in with your campus email</h2>
        <p className="muted mt-1">Students with a confirmed @purdue.edu email get a verified badge. Typing a school name never does.</p>
        {supabaseConfigured() ? (
          <ActionForm action={signInWithEmail} submitLabel="Email me a sign-in link" pendingLabel="Sending…" className="mt-3">
            <label className="label" htmlFor="email">Email</label>
            <input id="email" name="email" type="email" required placeholder="you@purdue.edu" className="input" autoComplete="email" />
          </ActionForm>
        ) : (
          <p className="mt-3 rounded-lg bg-accent-soft p-3 text-sm">Supabase Auth isn&apos;t configured for this deployment.</p>
        )}
      </section>

      {demoMode() && (
        <section className="card border-accent/40">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Demo personas</h2>
            <span className="text-xs text-muted">fictional · isolated from real accounts</span>
          </div>
          <p className="muted mt-1">Switch identities to walk both sides of a job. Demo personas only ever match other demo personas.</p>
          {personas.length === 0 ? (
            <p className="mt-3 text-sm">No demo data yet. Reset to load it.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line">
              {personas.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div>
                    <p className="font-medium">{p.display_name}</p>
                    <p className="text-xs text-muted">{blurb(p.display_name)}</p>
                  </div>
                  <form action={selectDemoPersona.bind(null, p.id)}>
                    <button className="btn-secondary min-h-9 px-3 py-1.5 text-sm">Use</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <details className="mt-3 rounded-xl bg-canvas p-3 text-sm">
            <summary className="cursor-pointer font-semibold">Demo script (about 3 minutes)</summary>
            <p className="mt-2 text-xs text-muted">Use the persona menu in the yellow banner to switch sides without leaving the page. Pages refresh on their own, so you can also keep two windows open.</p>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5">
              <li><strong>Riley</strong>, in the <em>Your agent</em> chat: say <em>find someone</em>. Agents negotiate: Sam is filtered out (too late), Maya accepts $5, and Nia haggles up to $6.50. The agent recommends Maya.</li>
              <li>Riley: <em>do it</em>. Maya&apos;s agent auto-accepts under her trip rule, and Riley&apos;s agent funds the $5 escrow.</li>
              <li>Switch to <strong>Maya</strong>: <em>picked up</em>. Riley&apos;s agent hands Riley the code.</li>
              <li>Maya: <em>code 000000</em> (rejected), then <em>code &lt;Riley&apos;s code&gt;</em>.</li>
              <li><strong>Riley</strong>: <em>got it</em>. Payment is released. Then <em>5 stars, super fast</em>.</li>
              <li>Open the task page to see the full agent-to-agent negotiation.</li>
              <li><strong>Detour Ops</strong>: <em>Disputes</em>. Settle Theo vs Sam (funds were frozen).</li>
            </ol>
          </details>
          <ActionButton action={resetDemoData} label="Reset demo data" pendingLabel="Resetting…" variant="secondary" className="mt-3"
            confirm="This deletes all demo-persona activity and reloads the seeded scenario. Real accounts are untouched." />
        </section>
      )}
    </div>
  );
}
