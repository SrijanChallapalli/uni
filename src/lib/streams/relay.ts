// Builds QuickNode-Streams-shaped `block_with_receipts` payloads from any EVM RPC.
// Used ONLY by the labeled local simulated stream source (scripts/local-stream-relay.ts) and tests,
// so the exact same webhook, filter and processing code runs without QuickNode credentials.
import type { PublicClient } from "viem";

const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;

export async function blockWithReceipts(client: PublicClient, blockNumber: bigint) {
  const block = await client.getBlock({ blockNumber, includeTransactions: false });
  const receipts = await Promise.all(block.transactions.map((h) => client.getTransactionReceipt({ hash: h })));
  return {
    block: { number: hex(block.number!), hash: block.hash, timestamp: hex(block.timestamp) },
    receipts: receipts.map((r) => ({
      transactionHash: r.transactionHash,
      status: r.status === "success" ? "0x1" : "0x0",
      logs: r.logs.map((l) => ({
        address: l.address, topics: l.topics, data: l.data, logIndex: hex(l.logIndex), blockNumber: hex(l.blockNumber),
        blockHash: l.blockHash, transactionHash: l.transactionHash, removed: l.removed,
      })),
    })),
  };
}

export async function payloadForRange(client: PublicClient, from: bigint, to: bigint) {
  const data = [];
  for (let b = from; b <= to; b++) data.push(await blockWithReceipts(client, b));
  return { data, metadata: { dataset: "block_with_receipts", start_range: Number(from), end_range: Number(to), network: "local-simulated" } };
}
