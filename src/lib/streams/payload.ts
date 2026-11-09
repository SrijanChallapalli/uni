import { createHmac, timingSafeEqual } from "node:crypto";
import type { RawLog } from "../escrow/abi";

// QuickNode Streams webhook authentication: HMAC-SHA256 keyed with the stream's security token
// over nonce + timestamp + raw (uncompressed) body, delivered in X-QN-Nonce / X-QN-Timestamp / X-QN-Signature.
export const MAX_SKEW_SECONDS = 300;

export function signPayload(secret: string, nonce: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(nonce + timestamp + body, "utf8").digest("hex");
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyStreamSignature(args: {
  secret: string | undefined;
  nonce: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  now?: Date;
}): VerifyResult {
  if (!args.secret) return { ok: false, reason: "stream secret not configured" };
  if (!args.nonce || !args.timestamp || !args.signature) return { ok: false, reason: "missing signature headers" };
  const ts = Number(args.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad timestamp" };
  const tsSec = ts > 1e12 ? ts / 1000 : ts;
  const nowSec = (args.now ?? new Date()).getTime() / 1000;
  if (Math.abs(nowSec - tsSec) > MAX_SKEW_SECONDS) return { ok: false, reason: "timestamp outside allowed window" };
  const expected = Buffer.from(signPayload(args.secret, args.nonce, args.timestamp, args.body), "hex");
  let got: Buffer;
  try {
    got = Buffer.from(args.signature.replace(/^0x/, ""), "hex");
  } catch {
    return { ok: false, reason: "bad signature encoding" };
  }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

const num = (v: unknown): number => (typeof v === "string" ? (v.startsWith("0x") ? parseInt(v, 16) : Number(v)) : Number(v));

function toRawLog(l: Record<string, unknown>, fallback: { tx?: string; block?: number; blockHash?: string | null }): RawLog | null {
  const topics = l.topics;
  if (typeof l.address !== "string" || !Array.isArray(topics) || typeof l.data !== "string") return null;
  const tx = (l.transactionHash as string) ?? fallback.tx;
  if (!tx) return null;
  return {
    address: l.address,
    topics: topics as string[],
    data: l.data,
    transactionHash: tx,
    logIndex: num(l.logIndex ?? 0),
    blockNumber: num(l.blockNumber ?? fallback.block ?? 0),
    blockHash: (l.blockHash as string) ?? fallback.blockHash ?? null,
    removed: Boolean(l.removed),
  };
}

/**
 * Accepts (a) the output of our Streams filter: { matchedLogs: [...] } (possibly wrapped in an array),
 * or (b) an unfiltered block_with_receipts payload: [{ block, receipts: [{ logs: [...] }] }].
 * Returns logs emitted by the configured escrow contract only.
 */
export function extractLogs(payload: unknown, contract: string): RawLog[] {
  const want = contract.toLowerCase();
  const out: RawLog[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const o = node as Record<string, unknown>;
    if (Array.isArray(o.matchedLogs)) {
      for (const l of o.matchedLogs) { const r = toRawLog(l as Record<string, unknown>, {}); if (r) out.push(r); }
      return;
    }
    if (Array.isArray(o.receipts)) {
      const block = o.block as Record<string, unknown> | undefined;
      for (const rc of o.receipts as Record<string, unknown>[]) {
        for (const l of (rc.logs as Record<string, unknown>[]) ?? []) {
          const r = toRawLog(l, { tx: rc.transactionHash as string, block: block ? num(block.number) : undefined, blockHash: (block?.hash as string) ?? null });
          if (r) out.push(r);
        }
      }
      return;
    }
    if (o.data) visit(o.data);
  };
  visit(payload);
  return out.filter((l) => l.address.toLowerCase() === want);
}
