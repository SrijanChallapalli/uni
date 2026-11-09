import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// The code is derived on demand from a server secret + per-task salt so the requester can
// view it again, while the database stores only an HMAC of the code (never the code).
export const MAX_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

function secret(): string {
  const s = process.env.HANDOFF_SECRET;
  if (!s || s.length < 16) throw new Error("HANDOFF_SECRET must be set (16+ chars)");
  return s;
}

export function newSalt(): string {
  return randomBytes(16).toString("hex");
}

export function deriveCode(taskId: string, salt: string): string {
  const mac = createHmac("sha256", secret()).update(`code:${taskId}:${salt}`).digest();
  const n = mac.readUInt32BE(0) % 1_000_000;
  return String(n).padStart(6, "0");
}

export function hashCode(taskId: string, code: string): string {
  return createHmac("sha256", secret()).update(`verify:${taskId}:${code}`).digest("hex");
}

export function normalizeCode(input: string): string | null {
  const c = input.replace(/\s|-/g, "");
  return /^\d{6}$/.test(c) ? c : null;
}

export function codeMatches(taskId: string, input: string, storedHash: string): boolean {
  const c = normalizeCode(input);
  if (!c) return false;
  const a = Buffer.from(hashCode(taskId, c), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type AttemptDecision =
  | { ok: true }
  | { ok: false; reason: "used" | "locked" | "wrong"; attemptsLeft?: number; lockedUntil?: Date };

/** Pure decision for one verification attempt given the stored row state. */
export function decideAttempt(row: { attempts: number; lockedUntil: Date | null; usedAt: Date | null }, matches: boolean, now: Date): {
  decision: AttemptDecision;
  nextAttempts: number;
  nextLockedUntil: Date | null;
} {
  if (row.usedAt) return { decision: { ok: false, reason: "used" }, nextAttempts: row.attempts, nextLockedUntil: row.lockedUntil };
  if (row.lockedUntil && row.lockedUntil > now)
    return { decision: { ok: false, reason: "locked", lockedUntil: row.lockedUntil }, nextAttempts: row.attempts, nextLockedUntil: row.lockedUntil };
  const attempts = row.lockedUntil && row.lockedUntil <= now ? 0 : row.attempts; // lock expired → reset
  if (matches) return { decision: { ok: true }, nextAttempts: attempts, nextLockedUntil: null };
  const next = attempts + 1;
  if (next >= MAX_ATTEMPTS) {
    const until = new Date(now.getTime() + LOCK_MINUTES * 60000);
    return { decision: { ok: false, reason: "locked", lockedUntil: until }, nextAttempts: next, nextLockedUntil: until };
  }
  return { decision: { ok: false, reason: "wrong", attemptsLeft: MAX_ATTEMPTS - next }, nextAttempts: next, nextLockedUntil: null };
}
