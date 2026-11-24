import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { CalendarHub, CalendarEvent } from "../adapters/calendar.js";
import type { ShoppingList } from "./shopping-list.js";
import type { AppUser } from "./checks.js";
import { berlinIso, parseBerlin } from "./time.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;
type Body = (req: IncomingMessage) => Promise<Record<string, unknown>>;

/** Termin-Kennung für den Planer: Apple-Objektadresse (base64url) – nur Apple-Termine ohne Serie sind änderbar. */
const encodeId = (ref: string) => Buffer.from(ref).toString("base64url");
const decodeId = (id: string) => Buffer.from(id, "base64url").toString("utf8");

const EventBody = z.object({
  calendar: z.string().min(1),
  title: z.string().min(1).max(300),
  start: z.string().min(10),
  end: z.string().min(10).optional(),
  all_day: z.boolean().default(false),
  location: z.string().max(500).nullish(),
  notes: z.string().max(4000).nullish(),
});

function toInput(b: z.infer<typeof EventBody>) {
  if (b.all_day) return { title: b.title, start: b.start.slice(0, 10), end: (b.end ?? b.start).slice(0, 10), allDay: true, location: b.location ?? null, notes: b.notes ?? null };
  const start = parseBerlin(b.start);
  const end = b.end ? parseBerlin(b.end) : new Date(start.getTime() + 3_600_000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error("Zeit nicht lesbar");
  if (end < start) throw new Error("Ende liegt vor dem Beginn");
  return { title: b.title, start: berlinIso(start), end: berlinIso(end), allDay: false, location: b.location ?? null, notes: b.notes ?? null };
}

function view(e: CalendarEvent, owner: string | null, writable: Set<string>) {
  return {
    id: e.ref ? encodeId(e.ref) : null,
    calendar: e.calendar, owner, title: e.title, start: e.start, end: e.end, all_day: e.allDay,
    location: e.location, notes: e.notes ?? null,
    recurring: Boolean(e.recurring),
    editable: Boolean(e.ref) && !e.recurring && writable.has(e.calendar.toLowerCase()),
  };
}

/**
 * Familienplaner-API: Kalender kommt live aus allen Hausgeist-Quellen (Apple, Abos, Home Assistant),
 * geschrieben wird direkt in den Apple-Kalender. Die Einkaufsliste IST die Bring!-Liste.
 * Keine Kopien im Planer – damit läuft nichts mehr auseinander.
 */
export async function handlePlanner(
  req: IncomingMessage, res: ServerResponse, path: string, url: URL, user: AppUser,
  deps: { calendar: CalendarHub; shopping: ShoppingList; json: Json; readBody: Body },
): Promise<boolean> {
  const i = path.indexOf("/api/planner/");
  if (i < 0) return false;
  const rest = path.slice(i + 12);
  const { calendar, shopping, json, readBody } = deps;
  if (user.role === "child") { json(res, 403, { error: "Für Kinder nicht freigegeben." }); return true; }

  try {
    // ── Kalender ──────────────────────────────────────────────
    if (req.method === "GET" && rest === "/calendars") {
      json(res, 200, { calendars: calendar.enabled ? await calendar.listCalendars() : [] });
      return true;
    }
    if (req.method === "GET" && rest === "/events") {
      const from = url.searchParams.get("from"), to = url.searchParams.get("to");
      if (!from || !to) throw new Error("from und to angeben");
      const f = parseBerlin(from), t = parseBerlin(to);
      if (t.getTime() - f.getTime() > 400 * 86_400_000) throw new Error("Zeitraum zu groß (max. 400 Tage)");
      const cals = calendar.enabled ? await calendar.listCalendars() : [];
      const writable = new Set(cals.filter((c) => c.writable).map((c) => c.name.toLowerCase()));
      const evs = calendar.enabled ? await calendar.events(f.toISOString(), t.toISOString()) : [];
      json(res, 200, { events: evs.map((e) => view(e, calendar.ownerOf(e.calendar), writable)) });
      return true;
    }
    if (req.method === "POST" && rest === "/events") {
      if (!calendar.apple.enabled) throw new Error("Apple-Kalender ist im Hausgeist nicht eingerichtet");
      const b = EventBody.parse(await readBody(req));
      const uid = await calendar.apple.createEvent(b.calendar, toInput(b));
      json(res, 200, { ok: true, uid });
      return true;
    }
    const em = rest.match(/^\/events\/([\w-]+)$/);
    if (em && req.method === "PUT") {
      const b = EventBody.parse(await readBody(req));
      await calendar.apple.updateEvent(decodeId(em[1]), toInput(b), b.calendar);
      json(res, 200, { ok: true });
      return true;
    }
    if (em && req.method === "DELETE") {
      await calendar.apple.deleteEvent(decodeId(em[1]));
      json(res, 200, { ok: true });
      return true;
    }

    // ── Einkaufsliste (live Bring!) ───────────────────────────
    if (req.method === "GET" && rest === "/shopping") {
      const items = await shopping.list(url.searchParams.get("store") ?? undefined, url.searchParams.get("done") === "1");
      json(res, 200, { items });
      return true;
    }
    if (req.method === "POST" && rest === "/shopping") {
      const b = z.object({ items: z.array(z.object({ item: z.string().min(1).max(120), quantity: z.string().max(60).optional(), store: z.string().max(60).optional() })).min(1).max(50) }).parse(await readBody(req));
      json(res, 200, await shopping.add(b.items, user.id));
      return true;
    }
    if (req.method === "POST" && rest === "/shopping/check") {
      const b = z.object({ ids: z.array(z.string().min(1)).min(1).max(100) }).parse(await readBody(req));
      await shopping.checkOff(b.ids);
      json(res, 200, { ok: true });
      return true;
    }
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") : (e as Error).message;
    json(res, 400, { error: msg });
    return true;
  }
  json(res, 404, { error: "Unbekannt" });
  return true;
}
