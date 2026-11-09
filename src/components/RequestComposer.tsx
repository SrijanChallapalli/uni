"use client";

import { useState, useTransition } from "react";
import { createTaskAction, parseRequestAction } from "@/app/actions";
import type { ParseResult, RequestDraft } from "@/lib/agents/requester";
import { STORES, ZONES } from "@/lib/locations";
import { ActionForm } from "./ActionButton";

const EXAMPLE = "Can someone grab my prepaid Target order (ready at 5) and bring it to Windsor before 7pm? Small bag, up to $7. Order is under Riley D.";

const FIELD_LABEL: Record<string, string> = {
  store_id: "store", delivery_zone: "delivery area", pickup_window_start: "pickup start", pickup_window_end: "pickup end",
  delivery_deadline: "deadline", package_size: "package size", prepaid: "prepaid confirmation", max_fee: "max fee",
};

export function RequestComposer({ defaults }: { defaults: { maxFee: string; start: string; end: string; deadline: string } }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [version, setVersion] = useState(0);

  const d: Partial<RequestDraft> = result?.draft ?? {};
  const missing = new Set(result?.missing ?? []);
  const miss = (k: keyof RequestDraft) => (missing.has(k) ? "border-accent ring-2 ring-accent/30" : "");

  const parse = () => start(async () => {
    setError(null);
    const r = await parseRequestAction(text);
    if ("error" in r) { setError(r.error); return; }
    setResult(r);
    setVersion((v) => v + 1);
  });

  return (
    <div className="space-y-4">
      <div className="card">
        <label className="label" htmlFor="nl">Describe your errand</label>
        <textarea id="nl" className="input min-h-28" maxLength={1000} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={EXAMPLE} />
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn-primary flex-1" onClick={parse} disabled={pending || !text.trim()}>
            {pending ? "Your agent is reading…" : "Let my agent fill the form"}
          </button>
          <button type="button" className="btn-secondary" onClick={() => setText(EXAMPLE)} disabled={pending}>Use example</button>
        </div>
        {error && <p role="alert" className="mt-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        {result && (
          <div className="mt-3 space-y-2 text-sm">
            <p className="text-xs text-muted">Read by: {result.source === "llm" ? "LLM agent (validated)" : "rules-based parser (LLM not configured)"}</p>
            {result.question && <p className="rounded-lg bg-accent-soft px-3 py-2"><strong>Your agent asks:</strong> {result.question}</p>}
            {result.missing.length > 0 && <p className="text-muted">Still needed: {result.missing.map((m) => FIELD_LABEL[m] ?? m).join(", ")}. They&apos;re highlighted below.</p>}
            {result.notes.map((n) => <p key={n} className="text-muted">• {n}</p>)}
            {result.warnings.map((w) => <p key={w} className="rounded-lg bg-danger-soft px-3 py-2 text-danger">{w}</p>)}
          </div>
        )}
      </div>

      <ActionForm key={version} action={createTaskAction} submitLabel="Post request" pendingLabel="Posting…">
        <input type="hidden" name="raw_text" value={text} />
        <div className="card space-y-3">
          <h2 className="font-semibold">{result ? "Check what your agent understood" : "Or fill it in directly"}</h2>
          <div><label className="label" htmlFor="store_id">Store</label>
            <select id="store_id" name="store_id" className={`input ${miss("store_id")}`} defaultValue={d.store_id ?? ""} required>
              <option value="" disabled>Choose a store</option>{STORES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></div>
          <div><label className="label" htmlFor="order_reference">Order name / number (shown only to your worker)</label>
            <input id="order_reference" name="order_reference" className="input" maxLength={80} defaultValue={d.order_reference ?? ""} /></div>
          <div><label className="label" htmlFor="delivery_zone">Deliver to</label>
            <select id="delivery_zone" name="delivery_zone" className={`input ${miss("delivery_zone")}`} defaultValue={d.delivery_zone ?? ""} required>
              <option value="" disabled>Choose an area</option>{ZONES.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select></div>
          <div><label className="label" htmlFor="delivery_detail">Exact drop-off spot (shown only to your worker)</label>
            <input id="delivery_detail" name="delivery_detail" className="input" maxLength={200} placeholder="e.g. Windsor front desk lobby" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label" htmlFor="pws">Pickup from</label>
              <input id="pws" name="pickup_window_start" type="datetime-local" className={`input ${miss("pickup_window_start")}`} defaultValue={d.pickup_window_start ?? (result ? "" : defaults.start)} required /></div>
            <div><label className="label" htmlFor="pwe">Pickup until</label>
              <input id="pwe" name="pickup_window_end" type="datetime-local" className={`input ${miss("pickup_window_end")}`} defaultValue={d.pickup_window_end ?? (result ? "" : defaults.end)} required /></div>
          </div>
          <div><label className="label" htmlFor="dl">Deliver by</label>
            <input id="dl" name="delivery_deadline" type="datetime-local" className={`input ${miss("delivery_deadline")}`} defaultValue={d.delivery_deadline ?? (result ? "" : defaults.deadline)} required /></div>
          <div><label className="label" htmlFor="package_size">Package size</label>
            <select id="package_size" name="package_size" className={`input ${miss("package_size")}`} defaultValue={d.package_size ?? ""} required>
              <option value="" disabled>Choose a size</option><option value="small">Small (fits in a backpack)</option>
              <option value="medium">Medium (one bag or shoebox)</option><option value="large">Large (needs a car)</option>
            </select></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label" htmlFor="offered_fee">Opening offer ($)</label>
              <input id="offered_fee" name="offered_fee" inputMode="decimal" className="input" defaultValue={d.offered_fee ?? ""} required placeholder="5.00" /></div>
            <div><label className="label" htmlFor="max_fee">Max fee ($)</label>
              <input id="max_fee" name="max_fee" inputMode="decimal" className={`input ${miss("max_fee")}`} defaultValue={d.max_fee ?? defaults.maxFee} required /></div>
          </div>
          <p className="text-xs text-muted">Workers see your opening offer, not your max. Your agent accepts at most one counteroffer within your max.</p>
          <div><label className="label" htmlFor="instructions">Pickup instructions</label>
            <textarea id="instructions" name="instructions" className="input" maxLength={500} defaultValue={d.instructions ?? ""} placeholder="e.g. Drive Up counter, order under Riley D." /></div>
          <label className={`flex items-start gap-2 rounded-xl p-2 text-sm ${miss("prepaid")}`}>
            <input type="checkbox" name="prepaid" className="mt-1 size-4" defaultChecked={d.prepaid === true} required />
            <span>The order is <strong>already paid for</strong>. Workers never front purchase costs; escrow covers only the delivery fee.</span>
          </label>
          <label className="flex items-start gap-2 rounded-xl bg-canvas p-2 text-sm">
            <input type="checkbox" name="confirm_details" className="mt-1 size-4" required />
            <span>I checked these details. My agent can look for workers, but nothing is agreed or paid without my approval.</span>
          </label>
        </div>
      </ActionForm>
    </div>
  );
}
