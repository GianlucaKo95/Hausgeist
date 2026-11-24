import { icalToBerlin, isoToBerlin } from "../core/time.js";
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
  notes?: string | null;
  uid?: string;
  /** Serientermin (einzelne Vorkommen lassen sich hier nicht bearbeiten). */
  recurring?: boolean;
  /** Nur Apple-Kalender: Adresse des Kalenderobjekts – zum Ändern/Löschen. */
  ref?: string;
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
          start: icalToBerlin(start.value, start.params),
          end: cur.DTEND ? icalToBerlin(cur.DTEND.value, cur.DTEND.params) : null,
          allDay: start.params.includes("VALUE=DATE") && !start.params.includes("DATE-TIME"),
          location: cur.LOCATION ? unescape(cur.LOCATION.value) : null,
          notes: cur.DESCRIPTION ? unescape(cur.DESCRIPTION.value) : null,
          uid: cur.UID?.value,
          recurring: Boolean(cur.RRULE || cur["RECURRENCE-ID"]),
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

  /** Nach geänderten Zugangsdaten neu verbinden. */
  reset(): void {
    this.client = null;
    this.calendars = [];
  }

  private async connect(): Promise<DAVClient> {
    if (this.client) return this.client;
    const client = new DAVClient({
      serverUrl: "https://caldav.icloud.com",
      credentials: { username: this.config.icloud_user.trim(), password: this.config.icloud_app_password.replace(/\s+/g, "") },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
    if (!this.config.icloud_user || !this.config.icloud_app_password) {
      throw new Error("Apple-Kalender ist nicht eingerichtet – in der Hausgeist-App unter Einstellungen → Verwaltung → Kalender Apple-ID und App-Passwort eintragen.");
    }
    try {
      await client.login();
      this.calendars = await client.fetchCalendars();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/401|unauthori/i.test(msg)) {
        throw new Error("iCloud lehnt die Anmeldung ab (401). Bitte in der Hausgeist-App unter Einstellungen → Verwaltung → Kalender die Apple-ID (Haupt-E-Mail der Apple-ID) und ein neues app-spezifisches Passwort eintragen und auf „Verbinden“ tippen.");
      }
      throw e;
    }
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
      for (const o of objs) if (o.data) {
        const evs = parseEvents(String(o.data), String(cal.displayName ?? ""));
        const series = evs.length > 1;
        all.push(...evs.map((e) => ({ ...e, ref: o.url, recurring: e.recurring || series })));
      }
    }
    const t = (v: string) => new Date(v.length === 10 ? `${v}T00:00:00` : v).getTime();
    return all.sort((a, b) => t(a.start) - t(b.start));
  }

  async createEvent(calendarName: string, ev: EventInput) {
    const client = await this.connect();
    const cal = this.find(calendarName);
    const uid = randomUUID();
    const res = await client.createCalendarObject({ calendar: cal, iCalString: buildIcal(uid, ev), filename: `${uid}.ics` });
    if (!res.ok) throw new Error(`Termin anlegen fehlgeschlagen: ${res.status}`);
    return uid;
  }

  /** Kalender, zu dem eine Objekt-Adresse gehört (nur aus den eigenen Apple-Kalendern). */
  private owning(ref: string): DAVCalendar {
    const cal = this.calendars.find((c) => ref.startsWith(c.url));
    if (!cal) throw new Error("Termin gehört zu keinem verbundenen Apple-Kalender");
    return cal;
  }

  private async object(ref: string) {
    const client = await this.connect();
    const cal = this.owning(ref);
    const [obj] = await client.fetchCalendarObjects({ calendar: cal, objectUrls: [ref] });
    if (!obj?.data) throw new Error("Termin nicht gefunden – wurde er schon gelöscht?");
    if (/RRULE|RECURRENCE-ID/.test(String(obj.data))) throw new Error("Serientermine bitte direkt im Apple-Kalender ändern");
    return { client, cal, obj };
  }

  /** Einzelnen Termin lesen (für Änderungen: aktuelle Werte und Kalendername). */
  async getEvent(ref: string): Promise<CalendarEvent> {
    const { cal, obj } = await this.object(ref);
    const [ev] = parseEvents(String(obj.data), String(cal.displayName ?? ""));
    if (!ev) throw new Error("Termin nicht lesbar");
    return { ...ev, ref };
  }

  async updateEvent(ref: string, ev: EventInput, moveTo?: string) {
    const { client, cal, obj } = await this.object(ref);
    const uid = String(obj.data).match(/^UID:(.+)$/m)?.[1]?.trim() ?? randomUUID();
    const target = moveTo ? this.find(moveTo) : cal;
    if (target.url !== cal.url) {
      const c = await client.createCalendarObject({ calendar: target, iCalString: buildIcal(uid, ev), filename: `${uid}.ics` });
      if (!c.ok) throw new Error(`Termin verschieben fehlgeschlagen: ${c.status}`);
      await client.deleteCalendarObject({ calendarObject: { url: obj.url, etag: obj.etag } });
      return;
    }
    const res = await client.updateCalendarObject({ calendarObject: { url: obj.url, etag: obj.etag, data: buildIcal(uid, ev) } });
    if (!res.ok) throw new Error(`Termin ändern fehlgeschlagen: ${res.status}`);
  }

  async deleteEvent(ref: string) {
    const { client, obj } = await this.object(ref);
    const res = await client.deleteCalendarObject({ calendarObject: { url: obj.url, etag: obj.etag } });
    if (!res.ok && res.status !== 404) throw new Error(`Termin löschen fehlgeschlagen: ${res.status}`);
  }
}


export interface EventInput { title: string; start: string; end: string; location?: string | null; notes?: string | null; allDay?: boolean }

function icalDay(d: string): string { return d.slice(0, 10).replace(/-/g, ""); }

/** iCal für einen einzelnen Termin – ganztägig als Datum (Ende exklusiv), sonst als UTC-Zeitpunkt. */
export function buildIcal(uid: string, ev: EventInput): string {
  let times: string[];
  if (ev.allDay) {
    const start = ev.start.slice(0, 10);
    let end = ev.end.slice(0, 10);
    if (end <= start) { const d = new Date(`${start}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); end = d.toISOString().slice(0, 10); }
    times = [`DTSTART;VALUE=DATE:${icalDay(start)}`, `DTEND;VALUE=DATE:${icalDay(end)}`];
  } else {
    times = [`DTSTART:${toIcal(ev.start)}`, `DTEND:${toIcal(ev.end)}`];
  }
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//KoeVen//Hausgeist//DE", "BEGIN:VEVENT",
    `UID:${uid}`, `DTSTAMP:${toIcal(new Date().toISOString())}`, ...times, `SUMMARY:${escape(ev.title)}`,
    ...(ev.location ? [`LOCATION:${escape(ev.location)}`] : []),
    ...(ev.notes ? [`DESCRIPTION:${escape(ev.notes)}`] : []),
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
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
            start: isoToBerlin(i.start.dateTime ?? i.start.date ?? ""), end: (i.end?.dateTime ?? i.end?.date) ? isoToBerlin(i.end?.dateTime ?? i.end?.date ?? "") : null,
            allDay: Boolean(i.start.date && !i.start.dateTime),
          });
        }
      } catch (e) {
        errors.push(`${c.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (errors.length && all.length === 0) throw new Error(errors.join("; "));
    const t = (v: string) => new Date(v.length === 10 ? `${v}T00:00:00` : v).getTime();
    return all.sort((a, b) => t(a.start) - t(b.start));
  }
}
