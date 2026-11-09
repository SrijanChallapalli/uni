// LABELED SIMULATED STREAM SOURCE — not QuickNode.
// Polls an EVM RPC (local anvil or Arc Testnet), builds block_with_receipts payloads in the
// QuickNode Streams shape, applies the same streams/filter.js, signs them, and POSTs them to the
// app's Streams webhook with `x-detour-simulated-stream: 1`. The webhook accepts this only when
// ALLOW_SIMULATED_STREAM=true, and records the source as "simulated_stream".
//
//   npm run stream:relay -- --rpc http://127.0.0.1:8545 --webhook http://localhost:3000/api/streams/quicknode
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createPublicClient, http, type PublicClient } from "viem";
import { signPayload } from "../src/lib/streams/payload";
import { payloadForRange } from "../src/lib/streams/relay";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const rpc = arg("rpc", process.env.ARC_RPC_URL || "http://127.0.0.1:8545");
const webhook = arg("webhook", "http://localhost:3000/api/streams/quicknode");
const secret = process.env.SIMULATED_STREAM_SECRET;
const escrow = process.env.ESCROW_CONTRACT_ADDRESS;
if (!secret || !escrow) throw new Error("Set SIMULATED_STREAM_SECRET and ESCROW_CONTRACT_ADDRESS");

const filterSrc = readFileSync("streams/filter.js", "utf8").replace("0xREPLACE_WITH_DEPLOYED_TASKESCROW", escrow);
const filter = new Function(`${filterSrc}; return main;`)() as (s: unknown) => unknown;
const client = createPublicClient({ transport: http(rpc), cacheTime: 0 }) as PublicClient;

async function main() {
  let next = BigInt(arg("from", String(await client.getBlockNumber())));
  console.log(`[simulated-stream] ${rpc} → ${webhook} from block ${next}`);
  for (;;) {
    const head = await client.getBlockNumber();
    if (head >= next) {
      const raw = await payloadForRange(client, next, head);
      const filtered = filter(raw);
      if (filtered) {
        const body = JSON.stringify(filtered);
        const nonce = randomUUID();
        const ts = String(Math.floor(Date.now() / 1000));
        const res = await fetch(webhook, {
          method: "POST", body,
          headers: { "content-type": "application/json", "x-detour-simulated-stream": "1", "x-qn-nonce": nonce, "x-qn-timestamp": ts, "x-qn-signature": signPayload(secret!, nonce, ts, body) },
        });
        console.log(`[simulated-stream] blocks ${next}-${head}: ${res.status} ${await res.text()}`);
        if (!res.ok) { await new Promise((r) => setTimeout(r, 2000)); continue; } // retry same range
      }
      next = head + 1n;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
