// Integer token units only. USDC uses 6 decimals: $1.00 = 1_000_000 units.
export const UNIT_DECIMALS = 6;
export const UNITS_PER_DOLLAR = 1_000_000;
export const UNITS_PER_CENT = 10_000;

export function assertUnits(n: number, label = "amount"): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${label} must be a non-negative integer number of token units`);
  return n;
}

/** Parse a user-entered dollar string ("4", "4.5", "$4.50") into units, rejecting sub-cent precision. */
export function dollarsToUnits(input: string | number): number {
  const s = String(input).trim().replace(/^\$/, "");
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Invalid dollar amount: ${input}`);
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
  return assertUnits(cents * UNITS_PER_CENT);
}

export function unitsToDollarString(units: number): string {
  const cents = Math.round(assertUnits(units) / UNITS_PER_CENT);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function formatUsd(units: number | string | bigint): string {
  return `$${unitsToDollarString(Number(units))}`;
}

/** Round units down/up to whole cents (fees are always quoted in cents). */
export function floorToCent(units: number): number {
  return Math.floor(assertUnits(units) / UNITS_PER_CENT) * UNITS_PER_CENT;
}
export function ceilToCent(units: number): number {
  return Math.ceil(assertUnits(units) / UNITS_PER_CENT) * UNITS_PER_CENT;
}
