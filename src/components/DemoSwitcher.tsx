"use client";

import { usePathname } from "next/navigation";
import { useRef } from "react";
import { switchDemoPersona } from "@/app/actions";

/** Demo-only persona switcher that keeps you on the current page (e.g. the same task). */
export function DemoSwitcher({ currentId, personas }: { currentId: string; personas: { id: string; name: string }[] }) {
  const path = usePathname();
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} action={switchDemoPersona} className="inline-flex items-center gap-1">
      <input type="hidden" name="return_to" value={path} />
      <label htmlFor="demo-persona" className="sr-only">Switch demo persona</label>
      <select id="demo-persona" name="profile_id" defaultValue={currentId} onChange={() => form.current?.requestSubmit()}
        className="rounded-md border border-accent/40 bg-white px-1.5 py-0.5 text-xs font-semibold">
        {personas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <noscript><button className="underline">Switch</button></noscript>
    </form>
  );
}
