// QuickNode Streams filter for Detour escrow events on Arc Testnet.
// Dataset: block_with_receipts. Paste into the Stream's "Filter" step and replace ESCROW_ADDRESS.
// Returns null (no delivery) for blocks without escrow events, so the webhook only receives
// Funded / Released / Refunded / Disputed / Resolved logs from our contract.
function main(stream) {
  const ESCROW_ADDRESS = "0xREPLACE_WITH_DEPLOYED_TASKESCROW".toLowerCase();
  const TOPICS = {
    // keccak256 of the event signatures in contracts/src/TaskEscrow.sol
    "0x35e43b2ba3be150931239c4b635d183d0a09162df5b1a058e81cb2f0264b0075": "Funded",
    "0xc8fa66dff4b9073528c3f1bf21a8dc9a18fdf09847e88e96188bc953aef519f0": "Released",
    "0xf552ca82e113ac3c539c3d617f29fcd19c172a0c75dad017555c9e109f7fe183": "Refunded",
    "0x0ba174eb1c3530da63920b98261208eeb30b48447d1cfcbbdf116fd4ee8c62db": "Disputed",
    "0x1533b7b16b85f24f101c37f1d34f49c0c1241d18fdd9d29a5144c5411a9c0a8e": "Resolved",
  };
  const data = Array.isArray(stream.data) ? stream.data : [stream.data];
  const matchedLogs = [];
  for (const entry of data) {
    const block = entry.block || {};
    for (const receipt of entry.receipts || []) {
      for (const log of receipt.logs || []) {
        if (!log.address || log.address.toLowerCase() !== ESCROW_ADDRESS) continue;
        if (!log.topics || !TOPICS[log.topics[0]]) continue;
        matchedLogs.push({
          event: TOPICS[log.topics[0]],
          address: log.address,
          topics: log.topics,
          data: log.data,
          transactionHash: log.transactionHash || receipt.transactionHash,
          logIndex: log.logIndex,
          blockNumber: log.blockNumber || block.number,
          blockHash: log.blockHash || block.hash,
          removed: log.removed === true,
        });
      }
    }
  }
  if (matchedLogs.length === 0) return null;
  return { matchedLogs };
}
