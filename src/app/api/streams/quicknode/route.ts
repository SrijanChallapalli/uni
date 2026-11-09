import { gunzipSync } from "node:zlib";
import { NextResponse, type NextRequest } from "next/server";
import { one } from "@/lib/db";
import { ingestStreamPayload } from "@/lib/services/payments";
import { verifyStreamSignature } from "@/lib/streams/payload";

// QuickNode Streams webhook destination. Primary ingestion path for confirmed escrow events.
// 1) authenticate (HMAC over nonce+timestamp+body, timestamp window) 2) reject replayed nonces
// 3) decode only our contract's logs 4) process idempotently (dedupe key = contract:tx:logIndex).
export async function POST(req: NextRequest) {
  const raw = Buffer.from(await req.arrayBuffer());
  const body = req.headers.get("content-encoding") === "gzip" ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  const nonce = req.headers.get("x-qn-nonce");
  const timestamp = req.headers.get("x-qn-timestamp");
  const signature = req.headers.get("x-qn-signature");
  // A labeled local relay (scripts/local-stream-relay.ts) signs with a separate secret and is only accepted when enabled.
  const simulated = req.headers.get("x-detour-simulated-stream") === "1";
  if (simulated && process.env.ALLOW_SIMULATED_STREAM !== "true") {
    return NextResponse.json({ error: "simulated stream source disabled" }, { status: 403 });
  }
  const secret = simulated ? process.env.SIMULATED_STREAM_SECRET : process.env.QUICKNODE_STREAM_SECRET;
  const v = verifyStreamSignature({ secret, nonce, timestamp, signature, body });
  if (!v.ok) return NextResponse.json({ error: v.reason }, { status: 401 });

  const fresh = await one<{ id: number }>(
    "insert into stream_deliveries (nonce, source, signature_ok) values ($1,$2,true) on conflict (nonce) do nothing returning id",
    [nonce, simulated ? "simulated_stream" : "quicknode_stream"]);
  if (!fresh) return NextResponse.json({ ok: true, replay: true });

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  try {
    const counts = await ingestStreamPayload(payload, simulated ? "simulated_stream" : "quicknode_stream");
    await one("update stream_deliveries set event_count = $2 where id = $1", [fresh.id, counts.applied + counts.duplicate + counts.invalid + counts.ignored]);
    return NextResponse.json({ ok: true, ...counts });
  } catch (e) {
    // Let Streams retry: drop the nonce record so the redelivery isn't treated as a replay.
    await one("delete from stream_deliveries where id = $1", [fresh.id]);
    console.error("[streams] processing failed", e);
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }
}
