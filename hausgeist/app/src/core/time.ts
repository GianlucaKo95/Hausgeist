/** Zeit-Hilfen: alles für das Sprachmodell eindeutig in deutscher Zeit mit Offset. */
export const TZ = "Europe/Berlin";

/** Abstand der Zeitzone zu UTC in Minuten zu einem Zeitpunkt (Sommer-/Winterzeit beachtet). */
export function tzOffsetMinutes(date: Date, tz = TZ): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** Uhrzeit „an der Wand“ in einer Zeitzone → echter Zeitpunkt. */
export function wallToInstant(y: number, mo: number, d: number, h: number, mi: number, s: number, tz = TZ): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let off = tzOffsetMinutes(new Date(guess), tz);
  let t = guess - off * 60_000;
  const off2 = tzOffsetMinutes(new Date(t), tz); // um die Umstellung herum nachjustieren
  if (off2 !== off) { off = off2; t = guess - off * 60_000; }
  return new Date(t);
}

/** z. B. 2026-11-24T19:00:00+01:00 */
export function berlinIso(date: Date): string {
  const off = tzOffsetMinutes(date);
  const local = new Date(date.getTime() + off * 60_000);
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  return `${local.toISOString().slice(0, 19)}${sign}${hh}:${mm}`;
}

/** z. B. „Di., 24.11. 19:00“ */
export function berlinText(date: Date): string {
  return date.toLocaleString("de-DE", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function validTz(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/**
 * iCal-Zeit (DTSTART/DTEND) → deutsche Zeit mit Offset. Berücksichtigt UTC („Z“), TZID und
 * „schwebende“ Zeiten (ohne Angabe = deutsche Zeit). Ganztägige Termine bleiben ein Datum.
 */
export function icalToBerlin(value: string, params = ""): string {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return value;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return `${y}-${mo}-${d}`;
  if (z) return berlinIso(new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)));
  const tzid = params.match(/TZID=("?)([^";:]+)\1/)?.[2];
  const tz = tzid && validTz(tzid) ? tzid : TZ;
  return berlinIso(wallToInstant(+y, +mo, +d, +h, +mi, +s, tz));
}

/** Beliebige ISO-Zeit (mit Offset oder Z) → deutsche Zeit mit Offset; reine Daten bleiben. */
export function isoToBerlin(v: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? v : berlinIso(t);
}

/** Zeitangabe vom Sprachmodell: ohne Offset gilt deutsche Zeit (nicht UTC). */
export function parseBerlin(v: string): Date {
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/);
  if (m) return wallToInstant(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return new Date(v);
}
