import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { DemoSwitcher } from "@/components/DemoSwitcher";
import { getViewer, demoMode } from "@/lib/auth";
import { q } from "@/lib/db";
import { DEMO_PERSONAS } from "@/lib/seed";
import { signOut } from "./actions";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Detour — campus errands",
  description: "Get your errands done. Earn money from trips you're already taking.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#1f6f5c" };

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const viewer = await getViewer().catch(() => null);
  const p = viewer?.profile;
  const personas = viewer?.via === "demo"
    ? await q<{ id: string; name: string }>("select id, display_name as name from profiles where is_demo and display_name = any($1) order by created_at",
        [Object.values(DEMO_PERSONAS).map((d) => d.name)]).catch(() => [])
    : [];
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {viewer?.via === "demo" && (
          <div className="bg-accent-soft px-4 py-1.5 text-center text-xs text-ink">
            Demo mode (fictional personas, not verified students) · viewing as{" "}
            {p && <DemoSwitcher currentId={p.id} personas={personas} />}
          </div>
        )}
        <header className="sticky top-0 z-10 border-b border-line bg-canvas/90 backdrop-blur">
          <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3">
            <Link href={p ? "/dashboard" : "/"} className="text-lg font-bold tracking-tight">
              Detour<span className="text-brand">.</span>
            </Link>
            {p && (
              <nav className="flex items-center text-[13px] sm:gap-1 sm:text-sm">
                <Link className="rounded-lg px-1.5 py-1.5 sm:px-2 hover:bg-white" href="/dashboard">Home</Link>
                <Link className="rounded-lg px-1.5 py-1.5 sm:px-2 hover:bg-white" href="/jobs">Jobs</Link>
                <Link className="rounded-lg px-1.5 py-1.5 sm:px-2 hover:bg-white" href="/payments">Payments</Link>
                {p.is_resolver && <Link className="rounded-lg px-1.5 py-1.5 sm:px-2 hover:bg-white" href="/resolver">Disputes</Link>}
                <Link className="rounded-lg px-1.5 py-1.5 sm:px-2 hover:bg-white" href={`/profile/${p.id}`}>Me</Link>
                <form action={signOut}><button className="rounded-lg px-1.5 py-1.5 sm:px-2 text-muted hover:bg-white">Sign out</button></form>
              </nav>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-2xl px-4 pb-24 pt-4">{children}</main>
        <footer className="mx-auto max-w-2xl px-4 pb-8 text-xs text-muted">
          Testnet / simulated funds only. Travel times are fixture estimates, not live traffic.
          {demoMode() && " Demo mode is on."}
        </footer>
      </body>
    </html>
  );
}
