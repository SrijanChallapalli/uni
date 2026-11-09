// All user-facing times are campus-local (West Lafayette, Eastern time).
export const CAMPUS_TZ = "America/Indiana/Indianapolis";

function offsetMinutes(at: Date): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: CAMPUS_TZ, timeZoneName: "shortOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part);
  if (!m) return 0;
  const v = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -v : v;
}

/** "2026-11-08T18:30" (campus local) → Date. Throws on malformed input. */
export function fromCampusLocal(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Invalid date/time: ${s}`);
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let d = new Date(asUtc - offsetMinutes(new Date(asUtc)) * 60000);
  d = new Date(asUtc - offsetMinutes(d) * 60000); // second pass handles DST edges
  return d;
}

/** Date → "YYYY-MM-DDTHH:mm" in campus local time (for datetime-local inputs). */
export function toCampusLocal(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: CAMPUS_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Today (campus) at hh:mm, plus dayOffset days. */
export function campusAt(hh: number, mm: number, dayOffset = 0, now = new Date()): Date {
  const [date] = toCampusLocal(now).split("T");
  const [y, mo, d] = date.split("-").map(Number);
  const base = new Date(Date.UTC(y, mo - 1, d + dayOffset));
  const ds = base.toISOString().slice(0, 10);
  return fromCampusLocal(`${ds}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`);
}

export function fmtTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", { timeZone: CAMPUS_TZ, hour: "numeric", minute: "2-digit" }).format(new Date(d));
}

export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CAMPUS_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(new Date(d));
}
