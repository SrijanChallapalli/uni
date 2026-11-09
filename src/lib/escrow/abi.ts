import { decodeEventLog, keccak256, toEventSelector, toHex, type Hex } from "viem";

export const escrowAbi = [
  { type: "function", name: "fund", stateMutability: "nonpayable", inputs: [
    { name: "id", type: "bytes32" }, { name: "worker", type: "address" }, { name: "amount", type: "uint96" }, { name: "refundAfter", type: "uint40" }], outputs: [] },
  { type: "function", name: "release", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "refund", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "dispute", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "resolve", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }, { name: "toWorker", type: "bool" }], outputs: [] },
  { type: "function", name: "resolveByTimeout", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "event", name: "Funded", inputs: [
    { name: "id", type: "bytes32", indexed: true }, { name: "payer", type: "address", indexed: true },
    { name: "worker", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }, { name: "refundAfter", type: "uint256", indexed: false }] },
  { type: "event", name: "Released", inputs: [
    { name: "id", type: "bytes32", indexed: true }, { name: "worker", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "Refunded", inputs: [
    { name: "id", type: "bytes32", indexed: true }, { name: "payer", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "Disputed", inputs: [{ name: "id", type: "bytes32", indexed: true }, { name: "by", type: "address", indexed: true }] },
  { type: "event", name: "Resolved", inputs: [
    { name: "id", type: "bytes32", indexed: true }, { name: "toWorker", type: "bool", indexed: false }, { name: "amount", type: "uint256", indexed: false }] },
] as const;

export const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
] as const;

export const EVENT_TOPICS = {
  Funded: toEventSelector("Funded(bytes32,address,address,uint256,uint256)"),
  Released: toEventSelector("Released(bytes32,address,uint256)"),
  Refunded: toEventSelector("Refunded(bytes32,address,uint256)"),
  Disputed: toEventSelector("Disputed(bytes32,address)"),
  Resolved: toEventSelector("Resolved(bytes32,bool,uint256)"),
} as const;

/** Opaque on-chain id for a payment. Contains no personal data. */
export function escrowIdFor(paymentId: string): Hex {
  return keccak256(toHex(`detour:payment:${paymentId}`));
}

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string | null;
  removed?: boolean;
}

export interface DecodedEscrowEvent {
  type: "Funded" | "Released" | "Refunded" | "Disputed" | "Resolved";
  escrowId: string;
  amount: number | null;
  toWorker?: boolean;
  worker?: string;
  payer?: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string | null;
  contract: string;
  removed: boolean;
}

export function decodeEscrowLog(log: RawLog): DecodedEscrowEvent | null {
  try {
    const ev = decodeEventLog({ abi: escrowAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
    const a = ev.args as Record<string, unknown>;
    const amount = typeof a.amount === "bigint" ? Number(a.amount) : null;
    if (amount !== null && !Number.isSafeInteger(amount)) return null;
    return {
      type: ev.eventName as DecodedEscrowEvent["type"],
      escrowId: String(a.id).toLowerCase(),
      amount,
      toWorker: typeof a.toWorker === "boolean" ? a.toWorker : undefined,
      worker: a.worker ? String(a.worker).toLowerCase() : undefined,
      payer: a.payer ? String(a.payer).toLowerCase() : undefined,
      txHash: log.transactionHash.toLowerCase(),
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      contract: log.address.toLowerCase(),
      removed: Boolean(log.removed),
    };
  } catch {
    return null;
  }
}
