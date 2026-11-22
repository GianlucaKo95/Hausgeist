import { DAVClient, type DAVCalendar } from "tsdav";
import { randomUUID } from "node:crypto";
import type { Config } from "../core/config.js";
import type { HomeAssistant } from "./homeassistant.js";

export interface CalendarEvent {
  calendar: string;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  location: string | null;
}

/** Entfaltet gefaltete iCal-Zeilen und liest die wichtigsten Felder eines VEVENT. */
export function parseEvents(ical: string, calendar: string): CalendarEvent[] {
  const lines = ical.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events: CalendarEvent[] = [];
  let cur: Record<string, { value: string; params: string }> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT" && cur) {
      const start = cur.DTSTART;
      if (start) {
        events.push({
          calendar,
          title: unescape(cur.SUMMARY?.value ?? "(ohne Titel)"),
          start: icalDate(start.value),
          end: cur.DTEND ? icalDate(cur.DTEND.value) : null,
          allDay: start.params.includes("VALUE=DATE") && !start.params.includes("DATE-TIME"),
          location: cur.LOCATION ? unescape(cur.LOCATION.value) : null,
        });
      }
      cur = null;
    } else if (cur) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const [name, ...params] = line.slice(0, idx).split(";");
      cur[name] = { value: line.slice(idx + 1), params: params.join(";") };
    }
  }
  return events;
}

function unescape(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

function escape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
}

/** 20261124T183000Z / 20261124T183000 / 20261124 → ISO-ähnlicher String. */
export function icalDate(v: string): string {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return v;
  const [, y, mo, d, h, mi, s, z] = m;
  return h ? `${y}-${mo}-${d}T${h}:${mi}:${s}${z ? "Z" : ""}` : `${y}-${mo}-${d}`;
}

function toIcal(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export class AppleCalendar {
  private client: DAVClient | null = null;
  private calendars: DAVCalendar[] = [];

  constructor(private readonly config: Config) {}

  get enabled(): boolean {
    return Boolean(this.config.icloud_user && this.config.icloud_app_password);
  }

  private async connect(): Promise<DAVClient> {
    if (this.client) return this.client;
    const client = new DAVClient({
      serverUrl: "https://caldav.icloud.com",
      credentials: { username: this.config.icloud_user, password: this.config.icloud_app_password },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
    await client.login();
    this.calendars = await client.fetchCalendars();
    this.client = client;
    return client;
  }

  async listCalendars(): Promise<string[]> {
    await this.connect();
    return this.calendars.map((c) => String(c.displayName ?? c.url));
  }

  private find(name: string): DAVCalendar {
    const cal = this.calendars.find((c) => String(c.displayName ?? "").toLowerCase() === name.toLowerCase());
    if (!cal) throw new Error(`Kalender "${name}" nicht gefunden`);
    return cal;
  }

  async events(fromIso: string, toIso: string, names?: string[]): Promise<CalendarEvent[]> {
    const client = await this.connect();
    const selected = names?.length ? names.map((n) => this.find(n)) : this.calendars;
    const all: CalendarEvent[] = [];
    for (const cal of selected) {
      // expand: Der Server löst Serientermine (z. B. wöchentliches Training) in einzelne Termine auf.
      const objs = await client.fetchCalendarObjects({ calendar: cal, timeRange: { start: fromIso, end: toIso }, expand: true });
      for (const o of objs) if (o.data) all.push(...parseEvents(String(o.data), String(cal.displayName ?? "")));
    }
    return all.sort((a, b) => a.start.localeCompare(b.start));
  }

  async createEvent(calendarName: string, ev: { title: string; start: string; end: string; location?: string | null; notes?: string | null }) {
    const client = await this.connect();
    const cal = this.find(calendarName);
    const uid = randomUUID();
    const ical = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//KoeVen//Hausgeist//DE", "BEGIN:VEVENT",
      `UID:${uid}`, `DTSTAMP:${toIcal(new Date().toISOString())}`,
      `DTSTART:${toIcal(ev.start)}`, `DTEND:${toIcal(ev.end)}`, `SUMMARY:${escape(ev.title)}`,
      ...(ev.location ? [`LOCATION:${escape(ev.location)}`] : []),
      ...(ev.notes ? [`DESCRIPTION:${escape(ev.notes)}`] : []),
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const res = await client.createCalendarObject({ calendar: cal, iCalString: ical, filename: `${uid}.ics` });
    if (!res.ok) throw new Error(`Termin anlegen fehlgeschlagen: ${res.status}`);
    return uid;
  }
}


/** Liegt ein Termin (ganztägig oder mit Uhrzeit) im Zeitraum? */
export function inRange(ev: CalendarEvent, fromIso: string, toIso: string): boolean {
  const start = Date.parse(ev.start.length === 10 ? `${ev.start}T00:00:00` : ev.start);
  const end = ev.end ? Date.parse(ev.end.length === 10 ? `${ev.end}T00:00:00` : ev.end) : start;
  return end >= Date.parse(fromIso) && start < Date.parse(toIso);
}

/**
 * Alle Kalenderquellen zusammen: Apple-Kalender (CalDAV), abonnierte
 * ICS-Kalender (z. B. Abfuhrkalender der Stadt) und Kalender aus Home
 * Assistant (z. B. Waste Collection Schedule). Schreiben nur in Apple-Kalender.
 */
export class CalendarHub {
  private feedCache = new Map<string, { at: number; ics: string }>();

  constructor(private readonly config: Config, readonly apple: AppleCalendar, private readonly ha: HomeAssistant) {}

  get enabled(): boolean {
    return this.apple.enabled || this.config.calendar_feeds.length > 0 || this.config.ha_calendars.length > 0;
  }

  /** Name → Besitzer ("shared" = ganzer Haushalt). */
  ownerOf(calendar: string): string | null {
    const all = [
      ...this.config.calendars,
      ...this.config.calendar_feeds.map((f) => ({ name: f.name, owner: f.owner })),
      ...this.config.ha_calendars.map((c) => ({ name: c.name, owner: c.owner })),
    ];
    return all.find((c) => c.name.toLowerCase() === calendar.toLowerCase())?.owner ?? null;
  }

  async listCalendars(): Promise<{ name: string; source: string; owner: string | null; writable: boolean }[]> {
    const out: { name: string; source: string; owner: string | null; writable: boolean }[] = [];
    if (this.apple.enabled) for (const n of await this.apple.listCalendars()) out.push({ name: n, source: "Apple", owner: this.ownerOf(n), writable: true });
    for (const f of this.config.calendar_feeds) out.push({ name: f.name, source: "Abo (ICS)", owner: f.owner, writable: false });
    for (const c of this.config.ha_calendars) out.push({ name: c.name, source: "Home Assistant", owner: c.owner, writable: false });
    return out;
  }

  private async feed(url: string): Promise<string> {
    const cached = this.feedCache.get(url);
    if (cached && Date.now() - cached.at < 6 * 3_600_000) return cached.ics;
    const res = await fetch(url.replace(/^webcal:/, "https:"));
    if (!res.ok) throw new Error(`Kalender-Abo ${url}: ${res.status}`);
    const ics = await res.text();
    this.feedCache.set(url, { at: Date.now(), ics });
    return ics;
  }

  async events(fromIso: string, toIso: string, names?: string[]): Promise<CalendarEvent[]> {
    const want = (n: string) => !names?.length || names.some((x) => x.toLowerCase() === n.toLowerCase());
    const all: CalendarEvent[] = [];
    const errors: string[] = [];

    if (this.apple.enabled) {
      try {
        const appleNames = await this.apple.listCalendars();
        const sel = appleNames.filter(want);
        if (sel.length) all.push(...(await this.apple.events(fromIso, toIso, names?.length ? sel : undefined)));
      } catch (e) {
        errors.push(`Apple: ${e instanceof Error ? e.message : e}`);
      }
    }
    for (const f of this.config.calendar_feeds.filter((f) => want(f.name))) {
      try {
        all.push(...parseEvents(await this.feed(f.url), f.name).filter((e) => inRange(e, fromIso, toIso)));
      } catch (e) {
        errors.push(`${f.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    for (const c of this.config.ha_calendars.filter((c) => want(c.name))) {
      try {
        const items = await this.ha.calendarEvents(c.entity_id, fromIso, toIso);
        for (const i of items) {
          all.push({
            calendar: c.name, title: i.summary, location: i.location ?? null,
            start: i.start.dateTime ?? i.start.date ?? "", end: i.end?.dateTime ?? i.end?.date ?? null,
            allDay: Boolean(i.start.date && !i.start.dateTime),
          });
        }
      } catch (e) {
        errors.push(`${c.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (errors.length && all.length === 0) throw new Error(errors.join("; "));
    return all.sort((a, b) => a.start.localeCompare(b.start));
  }
}
