# QuickNode Streams integration

Streams is the **primary** path by which confirmed escrow events (`Funded`, `Released`, `Refunded`, `Disputed`, `Resolved`) update payments and trigger in-app notifications. Submitting a transaction only marks the payment *pending*.

## Status

- ✅ Webhook auth, replay protection, filter, decoding, idempotent processing and reconciliation are tested with **real escrow logs from a local chain** (`tests/integration/chain.test.ts`).
- ✅ A **labeled simulated stream source** (`scripts/local-stream-relay.ts`) builds deliveries in the same shape from any RPC and signs them with a separate secret. The webhook accepts it only when `ALLOW_SIMULATED_STREAM=true` and records the source as `simulated_stream`.
- ⛔ **Not yet demonstrated against live QuickNode.** Needs a QuickNode account, a deployed `TaskEscrow` on Arc Testnet, and a public HTTPS URL for the webhook.

## Setup on QuickNode (Arc Testnet)

1. Deploy the contract (test key with Arc Testnet USDC for gas):
   ```bash
   cd contracts && USDC_ADDRESS=0x3600000000000000000000000000000000000000 RESOLVER_ADDRESS=<resolver addr> forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.arc.network --private-key $DEPLOYER_KEY --broadcast
   ```
   Put the address in `ESCROW_CONTRACT_ADDRESS` and the deploy block in `ESCROW_DEPLOY_BLOCK`.
2. QuickNode dashboard → **Streams → Create stream**
   - Chain **Arc**, network **Testnet**, dataset **Block with Receipts** (`block_with_receipts`)
   - Start: latest block, or the deploy block for backfill
   - Reorg handling: on. Batch size: 1 (for low latency)
3. **Filter:** paste [`filter.js`](filter.js) and replace `0xREPLACE_WITH_DEPLOYED_TASKESCROW` with the contract address (lowercase). It returns `null` for blocks without escrow events, so only matching logs are delivered as `{ matchedLogs: [...] }`.
4. **Destination:** Webhook → `https://<your-host>/api/streams/quicknode`, compression off or gzip (both handled). Copy the stream's **security token** into `QUICKNODE_STREAM_SECRET`.
5. Run a test: fund a task in the app with `ESCROW_MODE=arc_testnet`. The payment shows *Funding submitted* until the stream delivers the `Funded` log. *Payments → Escrow events* then shows it as "via quicknode stream" with an explorer link (`testnet.arcscan.app`).

## What the webhook does

1. Verifies `X-QN-Signature` = HMAC-SHA256(security token, nonce + timestamp + body) in constant time, and rejects timestamps more than 5 minutes off.
2. Stores the nonce (`stream_deliveries.nonce` is unique) so a replayed delivery is a no-op.
3. Extracts logs **only from `ESCROW_CONTRACT_ADDRESS`**, whether the payload is filtered or raw.
4. Decodes them with the contract ABI, then checks amount, worker address and contract.
5. Applies each event through the payment state machine with a unique dedupe key `contract:tx:logIndex`. Duplicates, out-of-order events and `removed` (reorged) logs are recorded but not applied.
6. On processing failure, returns 500 and deletes the nonce so QuickNode's retry is processed.

**Confirmations:** Arc uses deterministic BFT finality, so a delivered block is final. Reorg-flagged logs are still ignored defensively.

**Recovery:** `POST /api/ops/reconcile` (Bearer `OPS_TOKEN`) re-reads escrow logs from the RPC from a stored cursor and processes anything missed. Overlap with Streams is harmless because of the shared dedupe key.

## Example payload

[`example-payload.json`](example-payload.json) was captured from a real local run. It contains the raw `block_with_receipts` delivery and the output of `filter.js` for a `Funded` event.

## Local simulated source

```bash
anvil &
```

Deploy `MockUSDC` and `TaskEscrow`, set `ESCROW_MODE=arc_testnet`, `ARC_RPC_URL=http://127.0.0.1:8545`, `ARC_CHAIN_ID=31337`, the keys, `USDC_ADDRESS`, `ESCROW_CONTRACT_ADDRESS`, `ALLOW_SIMULATED_STREAM=true` and `SIMULATED_STREAM_SECRET`. Then run:

```bash
npm run stream:relay -- --rpc http://127.0.0.1:8545
```
