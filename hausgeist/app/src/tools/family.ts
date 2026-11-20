import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { db } from "../core/db.js";
import { ok, safe, type ToolContext } from "./context.js";

export function familyTools(ctx: ToolContext) {
  /** Wem gehört ein Kalender laut Konfiguration? "shared" = Familienkalender. */
  const ownerOf = (calendar: string) =>
    ctx.config.calendars.find((c) => c.name.toLowerCase() === calendar.toLowerCase())?.owner ?? null;

  return [
    tool("list_calendars", "Verfügbare Apple-Kalender und wem sie gehören.", {}, safe(async () => {
      if (!ctx.calendar.enabled) return ok("Apple-Kalender ist nicht konfiguriert (icloud_user / icloud_app_password).");
      const names = await ctx.calendar.listCalendars();
      return ok(names.map((n) => ({ name: n, owner: ownerOf(n) ?? "unbekannt" })));
    })),

    tool("list_events", "Termine in einem Zeitraum.", {
      from: z.string().describe("ISO-Datum/Zeit"),
      to: z.string().describe("ISO-Datum/Zeit"),
      calendars: z.array(z.string()).optional(),
    }, safe(async (a) => {
      if (!ctx.calendar.enabled) return ok("Apple-Kalender ist nicht konfiguriert.");
      const from = new Date(a.from).toISOString(), to = new Date(a.to).toISOString();
      return ok(await ctx.calendar.events(from, to, a.calendars));
    })),

    tool("create_event", "Termin eintragen. Im eigenen oder gemeinsamen Kalender direkt (Stufe 1), im Kalender einer anderen Person nur nach Freigabe (Stufe 2).", {
      calendar: z.string(),
      title: z.string(),
      start: z.string().describe("ISO-Datum/Zeit mit Zeitzone, z. B. 2026-11-24T18:30:00+01:00"),
      end: z.string(),
      location: z.string().optional(),
      notes: z.string().optional(),
    }, safe(async (a) => {
      if (!ctx.calendar.enabled) throw new Error("Apple-Kalender ist nicht konfiguriert");
      const owner = ownerOf(a.calendar);
      const mine = owner === "shared" || owner?.toLowerCase() === ctx.user.name.toLowerCase();
      const ev = { calendar: a.calendar, title: a.title, start: a.start, end: a.end, location: a.location ?? null, notes: a.notes ?? null };
      if (mine) {
        await ctx.calendar.createEvent(a.calendar, ev);
        return ok(`Termin „${a.title}“ eingetragen`);
      }
      const when = new Date(a.start).toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" });
      const r = await ctx.actions.request("calendar_event", ev, { agent: "family", summary: `${a.title}\n${when} in „${a.calendar}“`, requestedBy: ctx.user });
      return ok({ status: "Kalender einer anderen Person – Freigabe angefragt", an: r.approvers });
    })),

    tool("list_family_tasks", "Gemeinsame und eigene Aufgaben.", { include_done: z.boolean().default(false) }, safe(async (a) => {
      let q = db().from("family_tasks").select("id, title, shared, owner_id, due_at, done").or(`shared.eq.true,owner_id.eq.${ctx.user.id}`).order("due_at", { nullsFirst: false });
      if (!a.include_done) q = q.eq("done", false);
      const { data, error } = await q;
      if (error) throw error;
      return ok(data ?? []);
    })),

    tool("add_family_task", "Aufgabe anlegen – gemeinsam oder privat (Stufe 1).", {
      title: z.string(), shared: z.boolean().default(true), due_at: z.string().optional(),
    }, safe(async (a) => {
      const { error } = await db().from("family_tasks").insert({ title: a.title, shared: a.shared, owner_id: ctx.user.id, due_at: a.due_at ?? null });
      if (error) throw error;
      return ok("Aufgabe angelegt");
    })),

    tool("complete_family_task", "Aufgabe erledigen.", { id: z.string().uuid() }, safe(async (a) => {
      const { error } = await db().from("family_tasks").update({ done: true }).eq("id", a.id).or(`shared.eq.true,owner_id.eq.${ctx.user.id}`);
      if (error) throw error;
      return ok("Erledigt");
    })),

    tool("remind", "Erinnerung als Push an eine Person aus dem Haushalt schicken.", {
      person: z.string().describe("Name laut Nutzerliste"),
      message: z.string(),
    }, safe(async (a) => {
      const { data } = await db().from("users").select("name, notify_service").ilike("name", a.person).maybeSingle();
      if (!data?.notify_service) throw new Error(`${a.person} hat keinen Benachrichtigungsdienst`);
      await ctx.ha.notify(data.notify_service, `Erinnerung von ${ctx.user.name}`, a.message);
      return ok(`Erinnerung an ${data.name} geschickt`);
    })),
  ];
}
