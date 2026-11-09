import Link from "next/link";
import type { TaskStatus } from "@/lib/types";

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Looking for a worker",
  negotiating: "Waiting for approvals",
  agreed: "Agreed — awaiting escrow / pickup",
  picked_up: "Picked up — on the way",
  handed_off: "Handed off — confirm & release",
  completed: "Completed",
  cancelled: "Cancelled",
  disputed: "In dispute",
};

const TONE: Record<string, string> = {
  green: "bg-brand-soft text-brand",
  amber: "bg-accent-soft text-[#8a5a14]",
  red: "bg-danger-soft text-danger",
  blue: "bg-info-soft text-[#2c4a8a]",
  gray: "bg-canvas text-muted border border-line",
};

export function Pill({ tone = "gray", children }: { tone?: keyof typeof TONE; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[tone]}`}>{children}</span>;
}

export function taskTone(s: TaskStatus): keyof typeof TONE {
  return s === "completed" ? "green" : s === "cancelled" ? "gray" : s === "disputed" ? "red" : s === "open" ? "blue" : "amber";
}

export function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children, href, cta }: { children: React.ReactNode; href?: string; cta?: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-white/50 p-5 text-center text-sm text-muted">
      <p>{children}</p>
      {href && cta && <Link href={href} className="mt-3 inline-block font-semibold text-brand underline">{cta}</Link>}
    </div>
  );
}

export function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line py-2 text-sm last:border-0">
      <span className="text-muted">{k}</span>
      <span className="text-right font-medium">{v}</span>
    </div>
  );
}

export function TxLink({ hash, chainId }: { hash: string | null; chainId: number | null }) {
  if (!hash) return null;
  if (hash.startsWith("sim_")) return <span className="font-mono text-xs text-muted">{hash.slice(0, 18)}… (simulated)</span>;
  const base = chainId === 5042002 ? "https://testnet.arcscan.app/tx/" : null;
  const short = `${hash.slice(0, 10)}…${hash.slice(-6)}`;
  return base ? (
    <a className="font-mono text-xs text-brand underline" href={`${base}${hash}`} target="_blank" rel="noreferrer">{short}</a>
  ) : <span className="font-mono text-xs text-muted">{short}</span>;
}
