// Seeded Purdue-area locations. Coordinates are approximate and only used to derive
// FIXTURE travel times. These are not live traffic or routing estimates.
export type Mode = "walk" | "bike" | "bus" | "car";
export type PackageSize = "small" | "medium" | "large";

export interface Place { id: string; name: string; kind: "store" | "zone"; lat: number; lng: number }

export const STORES: Place[] = [
  { id: "target_wl", name: "Target (West Lafayette)", kind: "store", lat: 40.4597, lng: -86.9312 },
  { id: "walmart_laf", name: "Walmart Supercenter (Lafayette)", kind: "store", lat: 40.417, lng: -86.846 },
  { id: "cvs_state", name: "CVS (State St)", kind: "store", lat: 40.4237, lng: -86.908 },
  { id: "payless_wl", name: "Pay Less (Northwestern Ave)", kind: "store", lat: 40.443, lng: -86.919 },
];

export const ZONES: Place[] = [
  { id: "hillenbrand", name: "Hillenbrand / Meredith area", kind: "zone", lat: 40.4268, lng: -86.9268 },
  { id: "earhart_windsor", name: "Earhart / Windsor area", kind: "zone", lat: 40.4255, lng: -86.9245 },
  { id: "cary_quad", name: "Cary Quad / Tarkington area", kind: "zone", lat: 40.4318, lng: -86.9183 },
  { id: "harrison", name: "Harrison / Hawkins area", kind: "zone", lat: 40.4296, lng: -86.9248 },
  { id: "pmu", name: "Purdue Memorial Union", kind: "zone", lat: 40.4246, lng: -86.9109 },
  { id: "chauncey", name: "Chauncey Village (State St)", kind: "zone", lat: 40.4238, lng: -86.9064 },
  { id: "third_st", name: "Third St / Aspire area", kind: "zone", lat: 40.4196, lng: -86.9196 },
];

export const PLACES: Record<string, Place> = Object.fromEntries([...STORES, ...ZONES].map((p) => [p.id, p]));
export const STORE_IDS = STORES.map((s) => s.id) as [string, ...string[]];
export const ZONE_IDS = ZONES.map((z) => z.id) as [string, ...string[]];
export const isStore = (id: string) => STORES.some((s) => s.id === id);
export const isZone = (id: string) => ZONES.some((z) => z.id === id);

export function placeName(id: string): string {
  return PLACES[id]?.name ?? id;
}

const SPEED_KMH: Record<Mode, number> = { walk: 4.8, bike: 14, bus: 16, car: 30 };
// Fixed per-leg overhead (parking, unlocking a bike, waiting for a bus) in minutes.
const LEG_OVERHEAD_MIN: Record<Mode, number> = { walk: 0, bike: 2, bus: 8, car: 3 };
const ROAD_FACTOR = 1.35;

function haversineKm(a: Place, b: Place): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Fixture travel minutes between two seeded places (deterministic; labeled as fixture in the UI). */
export function fixtureTravelMinutes(fromId: string, toId: string, mode: Mode): number {
  if (fromId === toId) return 0;
  const a = PLACES[fromId];
  const b = PLACES[toId];
  if (!a || !b) throw new Error(`Unknown place: ${!a ? fromId : toId}`);
  const km = haversineKm(a, b) * ROAD_FACTOR;
  return Math.max(1, Math.round((km / SPEED_KMH[mode]) * 60 + LEG_OVERHEAD_MIN[mode]));
}

export const SIZE_RANK: Record<PackageSize, number> = { small: 1, medium: 2, large: 3 };
export const SIZE_LABEL: Record<PackageSize, string> = {
  small: "Small (fits in a backpack)",
  medium: "Medium (one shopping bag or shoebox)",
  large: "Large (needs both hands or a car)",
};
export const MODE_LABEL: Record<Mode, string> = { walk: "Walking", bike: "Bike / scooter", bus: "CityBus", car: "Car" };
/** Largest package each mode can reasonably carry, regardless of stated capacity. */
export const MODE_MAX_SIZE: Record<Mode, PackageSize> = { walk: "medium", bike: "medium", bus: "medium", car: "large" };
