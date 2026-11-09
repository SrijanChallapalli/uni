import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { one } from "@/lib/db";
import { erc20Abi } from "@/lib/escrow/abi";
import { approveAgreement, selectOffer } from "@/lib/services/agreements";
import { authorizeRelease, createTask, fundEscrow, markPickedUp, verifyHandoff } from "@/lib/services/lifecycle";
import { runMatching } from "@/lib/services/matching";
import { reconcile } from "@/lib/services/payments";
import { payloadForRange } from "@/lib/streams/relay";
import { signPayload } from "@/lib/streams/payload";
import { deriveCode } from "@/lib/handoff";
import { POST as streamWebhook } from "@/app/api/streams/quicknode/route";
import type { Payment } from "@/lib/types";
import { cleanup, clock, endPool, mkProfile, mkTrip, taskInput } from "./helpers";

// Real escrow transactions on a local anvil chain (stand-in for Arc Testnet: same contract, same
// adapter, same webhook). Confirmations reach the app only through the Streams webhook route.
const PORT = 8546;
const RPC = `http://127.0.0.1:${PORT}`;
const PAYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex; // anvil #0 (public test key)
const RESOLVER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex; // anvil #1
const WORKER_ADDR = "0x90f79bf6eb2c4f870365e785982e1f101e93b906"; // anvil #3
const STREAM_SECRET = "test-quicknode-stream-secret";
let anvil: ChildProcess;
let pub: PublicClient;

const artifact = (name: string) => JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`, "utf8")) as { abi: unknown[]; bytecode: { object: Hex } };

async function deploy(name: string, args: unknown[] = []) {
  const wallet = createWalletClient({ chain: foundry, transport: http(RPC), account: privateKeyToAccount(PAYER_KEY) });
  const a = artifact(name);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
}

/** Deliver blocks [from..latest] to the webhook exactly as QuickNode Streams would (signed). */
async function deliver(from: bigint, nonce: string) {
  const to = await pub.getBlockNumber();
  const raw = await payloadForRange(pub, from, to);
  const body = JSON.stringify(raw);
  if (process.env.WRITE_STREAM_EXAMPLE === "1" && nonce.startsWith("n-fund")) {
    const src = readFileSync("streams/filter.js", "utf8").replace("0xREPLACE_WITH_DEPLOYED_TASKESCROW", process.env.ESCROW_CONTRACT_ADDRESS!);
    const filtered = (new Function(`${src}; return main;`)() as (s: unknown) => unknown)(raw);
    writeFileSync("streams/example-payload.json", JSON.stringify({ note: "Captured from a local anvil run. raw = block_with_receipts delivery shape; filtered = what streams/filter.js forwards to the webhook.", raw, filtered }, null, 2) + "\n");
  }
  const ts = String(Math.floor(Date.now() / 1000));
  const req = new NextRequest("http://localhost/api/streams/quicknode", {
    method: "POST", body,
    headers: { "content-type": "application/json", "x-qn-nonce": nonce, "x-qn-timestamp": ts, "x-qn-signature": signPayload(STREAM_SECRET, nonce, ts, body) },
  });
  const res = await streamWebhook(req);
  return { status: res.status, json: await res.json(), to };
}

beforeAll(async () => {
  anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
  pub = createPublicClient({ chain: foundry, transport: http(RPC), cacheTime: 0 }) as PublicClient;
  for (let i = 0; i < 50; i++) { try { await pub.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const usdc = await deploy("MockUSDC");
  const resolver = privateKeyToAccount(RESOLVER_KEY).address;
  const escrow = await deploy("TaskEscrow", [usdc, resolver]);
  const wallet = createWalletClient({ chain: foundry, transport: http(RPC), account: privateKeyToAccount(PAYER_KEY) });
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: usdc, abi: erc20Abi, functionName: "mint", args: [wallet.account.address, 1_000_000_000n] }) });
  Object.assign(process.env, {
    ESCROW_MODE: "arc_testnet", ARC_RPC_URL: RPC, ARC_CHAIN_ID: "31337", USDC_ADDRESS: usdc, ESCROW_CONTRACT_ADDRESS: escrow.toLowerCase(),
    PLATFORM_SIGNER_KEY: PAYER_KEY, RESOLVER_KEY, QUICKNODE_STREAM_SECRET: STREAM_SECRET, ESCROW_DEPLOY_BLOCK: "0",
  });
  await cleanup();
  await one("delete from chain_cursor where id = 'escrow'");
}, 60_000);

afterAll(async () => {
  process.env.ESCROW_MODE = "simulated";
  await cleanup();
  await endPool();
  anvil?.kill();
});

describe("on-chain escrow + Streams-driven payment updates", () => {
  it("funds and releases real escrow; status changes only when the stream delivers confirmed events", async () => {
    const at = clock();
    const r = await mkProfile("chain-req");
    const w = await mkProfile("chain-worker", { payout: WORKER_ADDR });
    await mkTrip(w, at);
    const taskId = await createTask(r, taskInput(at));
    await runMatching(taskId, r);
    const offer = (await one<{ id: string }>("select id from offers where task_id = $1 and worker_id = $2", [taskId, w]))!;
    const ag = await selectOffer(offer.id, r);
    await approveAgreement(ag, 1, w);

    const start = await pub.getBlockNumber();
    const submitted = await fundEscrow(taskId, r);
    expect(submitted.mode).toBe("arc_testnet");
    expect(submitted.status).toBe("awaiting_funding"); // submitted ≠ confirmed
    expect(submitted.pending_action).toBe("fund");
    await expect(fundEscrow(taskId, r)).rejects.toThrow(/pending/); // no double funding while pending

    // Bad signature is rejected and changes nothing.
    const bad = await streamWebhook(new NextRequest("http://localhost/api/streams/quicknode", {
      method: "POST", body: "{}", headers: { "x-qn-nonce": "x", "x-qn-timestamp": String(Math.floor(Date.now() / 1000)), "x-qn-signature": "00" } }));
    expect(bad.status).toBe(401);

    const d1 = await deliver(start + 1n, `n-fund-${Date.now()}`);
    expect(d1.status).toBe(200);
    expect(d1.json.applied).toBe(1);
    let p = (await one<Payment>("select * from payments where task_id = $1", [taskId]))!;
    expect(p).toMatchObject({ status: "funded", pending_action: null });
    expect(p.fund_tx).toMatch(/^0x/);

    // Replay of the same nonce is ignored; a redelivery with a new nonce is deduplicated.
    const nonce = `n-dup-${Date.now()}`;
    expect((await deliver(start + 1n, nonce)).json.duplicate).toBe(1);
    expect((await deliver(start + 1n, nonce)).json.replay).toBe(true);

    await markPickedUp(taskId, w);
    const salt = (await one<{ salt: string }>("select salt from handoff_codes where task_id = $1", [taskId]))!.salt;
    expect((await verifyHandoff(taskId, w, deriveCode(taskId, salt))).ok).toBe(true);
    const before = await pub.readContract({ address: process.env.USDC_ADDRESS as Hex, abi: erc20Abi, functionName: "balanceOf", args: [WORKER_ADDR as Hex] });
    const rel = await authorizeRelease(taskId, r);
    expect(rel.status).toBe("funded"); // still pending until confirmed
    expect(rel.pending_action).toBe("release");

    // Simulate a missed webhook: recover through reconciliation instead.
    const rec = await reconcile();
    expect(rec.outcomes.applied).toBe(1);
    p = (await one<Payment>("select * from payments where task_id = $1", [taskId]))!;
    expect(p.status).toBe("released");
    const after = await pub.readContract({ address: process.env.USDC_ADDRESS as Hex, abi: erc20Abi, functionName: "balanceOf", args: [WORKER_ADDR as Hex] });
    expect(after - before).toBe(5_000_000n);
    // The stream arriving late after reconciliation is a harmless duplicate.
    const late = await deliver(start + 1n, `n-late-${Date.now()}`);
    expect(late.json.applied).toBe(0);
    expect((await one<{ status: string }>("select status from tasks where id = $1", [taskId]))!.status).toBe("completed");
  });
});
