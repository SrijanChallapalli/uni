import "server-only";
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, escrowAbi, type DecodedEscrowEvent, decodeEscrowLog } from "./abi";

export type EscrowMode = "simulated" | "arc_testnet";

export interface EscrowAdapter {
  mode: EscrowMode;
  chainId: number | null;
  contractAddress: string | null;
  payerAddress: string | null;
  fund(a: { escrowId: Hex; worker: string; amountUnits: number; refundAfter: Date }): Promise<{ txHash: string }>;
  release(escrowId: Hex): Promise<{ txHash: string }>;
  refund(escrowId: Hex): Promise<{ txHash: string }>;
  dispute(escrowId: Hex): Promise<{ txHash: string }>;
  resolve(escrowId: Hex, toWorker: boolean): Promise<{ txHash: string }>;
  /** Reconciliation: read confirmed escrow logs directly from the chain. */
  fetchEvents?(fromBlock: bigint, toBlock?: bigint): Promise<{ events: DecodedEscrowEvent[]; toBlock: bigint }>;
}

export function escrowMode(): EscrowMode {
  return process.env.ESCROW_MODE === "arc_testnet" ? "arc_testnet" : "simulated";
}

let simCounter = 0;
/** Clearly labeled simulated mode: no chain, deterministic tx ids prefixed "sim_". */
export function simulatedAdapter(): EscrowAdapter {
  const tx = (kind: string) => ({ txHash: `sim_${kind}_${Date.now().toString(36)}_${(++simCounter).toString(36)}` });
  return {
    mode: "simulated", chainId: null, contractAddress: null, payerAddress: null,
    fund: async () => tx("fund"), release: async () => tx("release"), refund: async () => tx("refund"),
    dispute: async () => tx("dispute"), resolve: async () => tx("resolve"),
  };
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for ESCROW_MODE=arc_testnet`);
  return v;
}

/**
 * Arc Testnet escrow (also used against local anvil in tests). Custodial demo model, disclosed in-app:
 * the app's platform signer funds and releases escrow on the requester's explicit in-app authorization,
 * and a separate resolver key handles disputes and resolver refunds. Keys never leave the server.
 */
export function arcAdapter(): EscrowAdapter {
  const chainId = Number(process.env.ARC_CHAIN_ID || 5042002);
  const rpc = need("ARC_RPC_URL");
  const chain = defineChain({
    id: chainId, name: chainId === 5042002 ? "Arc Testnet" : `chain-${chainId}`,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } },
  });
  const escrow = need("ESCROW_CONTRACT_ADDRESS") as Hex;
  const usdc = (process.env.USDC_ADDRESS || "0x3600000000000000000000000000000000000000") as Hex;
  const payer = privateKeyToAccount(need("PLATFORM_SIGNER_KEY") as Hex);
  const resolver = privateKeyToAccount(need("RESOLVER_KEY") as Hex);
  const pub = createPublicClient({ chain, transport: http(rpc), cacheTime: 0 });
  const payerWallet = createWalletClient({ chain, transport: http(rpc), account: payer });
  const resolverWallet = createWalletClient({ chain, transport: http(rpc), account: resolver });

  const write = async (wallet: typeof payerWallet, functionName: "release" | "refund" | "dispute" | "resolve" | "fund", args: readonly unknown[]) => {
    const { request } = await pub.simulateContract({ address: escrow, abi: escrowAbi, functionName, args: args as never, account: wallet.account });
    const txHash = await wallet.writeContract(request);
    return { txHash };
  };

  return {
    mode: "arc_testnet",
    chainId,
    contractAddress: escrow.toLowerCase(),
    payerAddress: payer.address.toLowerCase(),
    async fund({ escrowId, worker, amountUnits, refundAfter }) {
      const amount = BigInt(amountUnits);
      const allowance = await pub.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [payer.address, escrow] });
      if (allowance < amount) {
        const h = await payerWallet.writeContract({ address: usdc, abi: erc20Abi, functionName: "approve", args: [escrow, amount * 1000n] });
        await pub.waitForTransactionReceipt({ hash: h });
      }
      return write(payerWallet, "fund", [escrowId, worker as Hex, amount, BigInt(Math.floor(refundAfter.getTime() / 1000))]);
    },
    release: (id) => write(payerWallet, "release", [id]),
    refund: (id) => write(resolverWallet, "refund", [id]),
    dispute: (id) => write(resolverWallet, "dispute", [id]),
    resolve: (id, toWorker) => write(resolverWallet, "resolve", [id, toWorker]),
    async fetchEvents(fromBlock, toBlock) {
      const latest = toBlock ?? (await pub.getBlockNumber());
      const logs = await pub.getLogs({ address: escrow, fromBlock, toBlock: latest });
      const events = logs
        .map((l) => decodeEscrowLog({
          address: l.address, topics: l.topics as string[], data: l.data, transactionHash: l.transactionHash!,
          logIndex: l.logIndex!, blockNumber: Number(l.blockNumber), blockHash: l.blockHash, removed: l.removed,
        }))
        .filter((e): e is DecodedEscrowEvent => e !== null);
      return { events, toBlock: latest };
    },
  };
}

export function getAdapter(): EscrowAdapter {
  return escrowMode() === "arc_testnet" ? arcAdapter() : simulatedAdapter();
}
