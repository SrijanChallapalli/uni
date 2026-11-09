import "server-only";
import { Pool, types, type PoolClient } from "pg";

// int8 → number, guarded: all money values are integer token units well below 2^53.
types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 out of safe range: ${v}`);
  return n;
});
types.setTypeParser(1700, (v) => Number(v)); // numeric → number (scores, averages only)

const g = globalThis as unknown as { __detourPool?: Pool };

export function pool(): Pool {
  if (!g.__detourPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    g.__detourPool = new Pool({ connectionString: url, max: 10 });
  }
  return g.__detourPool;
}

export type Db = Pick<PoolClient, "query">;

export async function q<T = Record<string, unknown>>(text: string, params: unknown[] = [], db: Db = pool()): Promise<T[]> {
  const r = await db.query(text, params);
  return r.rows as T[];
}

export async function one<T = Record<string, unknown>>(text: string, params: unknown[] = [], db: Db = pool()): Promise<T | null> {
  const rows = await q<T>(text, params, db);
  return rows[0] ?? null;
}

/** Run fn in a transaction. Serialization/deadlock failures surface as errors (no silent retries). */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool().connect();
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
