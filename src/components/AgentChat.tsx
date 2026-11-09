"use client";

import { useActionState, useEffect, useRef } from "react";
import type { ActionState } from "@/app/actions";

export interface ChatMessage { id: number; role: "user" | "agent"; body: string }

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** The person's conversation with their own agent. They say what they want; the agent does it. */
export function AgentChat({ action, messages, suggestions, placeholder, title = "Your agent" }: {
  action: Action; messages: ChatMessage[]; suggestions: string[]; placeholder: string; title?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const form = useRef<HTMLFormElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const lastId = messages.at(-1)?.id;

  useEffect(() => { if (state?.ok) form.current?.reset(); }, [state]);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [lastId, pending]);

  return (
    <section className="card p-0" data-busy={pending ? "true" : undefined}>
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="font-semibold">{title}</h2>
        <span className="text-xs text-muted">acts only within your limits</span>
      </div>
      <div ref={list} className="max-h-80 space-y-2 overflow-y-auto px-4 py-3" aria-live="polite">
        {messages.length === 0 && (
          <p className="text-sm text-muted">Tell me what you need and I&apos;ll handle it: post the request, negotiate with other students&apos; agents, and keep you posted.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <p className={`max-w-[85%] whitespace-pre-line rounded-2xl px-3 py-2 text-sm ${m.role === "user" ? "bg-brand text-brand-ink" : "bg-canvas"}`}>{m.body}</p>
          </div>
        ))}
        {pending && <div className="flex justify-start"><p className="rounded-2xl bg-canvas px-3 py-2 text-sm text-muted">Working on it…</p></div>}
      </div>
      <form ref={form} action={formAction} className="border-t border-line px-4 py-3">
        <div className="flex gap-2">
          <label htmlFor="agent-text" className="sr-only">Message your agent</label>
          <input id="agent-text" name="text" className="input flex-1" placeholder={placeholder} autoComplete="off" maxLength={1000} disabled={pending} />
          <button className="btn-primary px-4" disabled={pending}>Send</button>
        </div>
        {suggestions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button key={s} name="chip" value={s} disabled={pending} className="rounded-full border border-line px-3 py-1 text-xs hover:bg-canvas disabled:opacity-50">{s}</button>
            ))}
          </div>
        )}
        {state?.error && <p role="alert" className="mt-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{state.error}</p>}
      </form>
    </section>
  );
}
