import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { runTimeouts } from "@/lib/services/lifecycle";
import { reconcile } from "@/lib/services/payments";

// Operational jobs, protected by OPS_TOKEN (Authorization: Bearer …). Suitable for a cron.
//   POST /api/ops/reconcile  — re-read escrow logs from chain; recovers events a stream missed
//   POST /api/ops/timeouts   — auto-release after verified handoff + 24h; refund on resolver timeout
function authorized(req: NextRequest): boolean {
  const token = process.env.OPS_TOKEN;
  const got = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!token || token.length < 16) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ job: string }> }) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { job } = await params;
  try {
    if (job === "reconcile") return NextResponse.json(await reconcile());
    if (job === "timeouts") return NextResponse.json({ done: await runTimeouts() });
    return NextResponse.json({ error: "unknown job" }, { status: 404 });
  } catch (e) {
    console.error(`[ops] ${job} failed`, e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
