"use client";

import { useActionState, useEffect, useState } from "react";
import type { ActionState } from "@/app/actions";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export function Feedback({ state }: { state: ActionState }) {
  if (!state) return null;
  if (state.error) return <p role="alert" className="mt-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{state.error}</p>;
  if (state.ok) return <p role="status" className="mt-2 rounded-lg bg-brand-soft px-3 py-2 text-sm text-brand">{state.ok}</p>;
  return null;
}

/** A single-button form bound to a server action, with pending, error, and optional confirm states. */
export function ActionButton({
  action, label, pendingLabel, variant = "primary", confirm, className = "",
}: { action: Action; label: string; pendingLabel?: string; variant?: "primary" | "secondary" | "danger"; confirm?: string; className?: string }) {
  const [state, formAction, pending] = useActionState(action, null);
  const [asking, setAsking] = useState(false);
  useEffect(() => { if (state) setAsking(false); }, [state]); // close the confirm panel once the action finishes
  const cls = variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : "btn-secondary";
  return (
    <div className={className} data-busy={pending || asking ? "true" : undefined}>
      {confirm && asking ? (
        <div className="rounded-xl border border-line bg-canvas p-3">
          <p className="mb-3 text-sm">{confirm}</p>
          <div className="flex gap-2">
            <form action={formAction} className="flex-1">
              <button className={`${cls} w-full`} disabled={pending}>{pending ? pendingLabel ?? "Working…" : "Yes, continue"}</button>
            </form>
            <button className="btn-secondary flex-1" onClick={() => setAsking(false)} disabled={pending}>Go back</button>
          </div>
        </div>
      ) : (
        <form action={confirm ? undefined : formAction} onSubmit={confirm ? (e) => { e.preventDefault(); setAsking(true); } : undefined}>
          <button className={`${cls} w-full`} disabled={pending}>{pending ? pendingLabel ?? "Working…" : label}</button>
        </form>
      )}
      <Feedback state={state} />
    </div>
  );
}

/** A form with arbitrary fields bound to a server action. */
export function ActionForm({
  action, children, submitLabel, pendingLabel, variant = "primary", className = "",
}: { action: Action; children: React.ReactNode; submitLabel: string; pendingLabel?: string; variant?: "primary" | "secondary" | "danger"; className?: string }) {
  const [state, formAction, pending] = useActionState(action, null);
  const cls = variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : "btn-secondary";
  return (
    <form action={formAction} className={className} data-busy={pending ? "true" : undefined}>
      <fieldset disabled={pending} className="space-y-3">
        {children}
        <button className={`${cls} w-full`}>{pending ? pendingLabel ?? "Working…" : submitLabel}</button>
      </fieldset>
      <Feedback state={state} />
    </form>
  );
}
