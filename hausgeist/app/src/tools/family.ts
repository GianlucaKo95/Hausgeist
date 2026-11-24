import { parseBerlin, berlinText, berlinIso } from "../core/time.js";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { db } from "../core/db.js";
import { ok, safe, findUser, requireAdult, type ToolContext } from "./context.js";
import { whereIs, zones, normZone } from "../core/location.js";

export function familyTools(ctx: ToolContext) {
  /** Wem gehört ein Kalender laut Konfiguration? "shared" = Familienkalender. */
  const ownerOf = (calendar: string) => ctx.calendar.ownerOf(calendar);

  /** Ändern/Löschen nur im eigenen oder gemeinsamen Kalender. */
  const mayEdit = (calendar: string) => {
    requireAdult(ctx);
    const owner = ownerOf(calendar);
    if (!(owner === "shared" || owner?.toLowerCase() === ctx.user.name.toLowerCase()))
      throw new Error(`„${calendar}“ gehört ${owner ?? "jemand anderem"} – ändern oder löschen nur im eigenen oder gemeinsamen Kalender`);
  };

  return [
    tool("list_places", "Orte (Zonen) aus Home Assistant, z. B. home, Arbeit, Schule – für Orts-Erinnerungen.", {}, safe(async () =>
      ok(zones(await ctx.ha.states())))),

    tool("my_location", "Wo ist die anfragende Person gerade (Zone bzw. unterwegs)? Nur der eigene Standort.", {}, safe(async () => {
      const where = whereIs(ctx.user, ctx.positions, await ctx.ha.states());
      if (!where) return ok("Kein Standort bekannt – in der Hausgeist-App unter Einstellungen „Standort für Erinnerungen“ einschalten (Zugriff „Immer“).");
      return ok({ zone: normZone(where.zone), quelle: where.source === "app" ? "Hausgeist-App" : "Home Assistant" });
    })),

    tool("create_location_reminder", "Erinnerung beim Verlassen oder Erreichen eines Ortes (Zone), z. B. „Wenn ich von zuhause losgehe: Müll mitnehmen“. Nur für die eigene Person.", {
      zone: z.string().describe("Zonenname aus list_places, z. B. home"),
      event: z.enum(["leave", "enter"]),
      message: z.string().min(1),
      repeat: z.boolean().default(false).describe("Jedes Mal statt nur einmal"),
    }, safe(async (a) => {
      const states = await ctx.ha.states();
      const where = whereIs(ctx.user, ctx.positions, states);
      if (!where) throw new Error("Für dich ist kein Standort verfügbar – in der Hausgeist-App unter Einstellungen „Standort für Erinnerungen“ einschalten.");
      const known = zones(states).map((x) => normZone(x.name));
      if (!known.includes(normZone(a.zone))) throw new Error(`Den Ort „${a.zone}“ gibt es nicht. Vorhanden: ${known.join(", ")}. Neue Orte legst du in Home Assistant unter Einstellungen → Bereiche & Zonen an.`);
      const current = where.zone;
      const { data, error } = await db().from("location_reminders").insert({
        user_id: ctx.user.id, zone: a.zone, event: a.event, message: a.message, repeat: a.repeat, last_state: current,
      }).select("id").single();
      if (error) throw error;
      return ok(`Angelegt (${data.id}): ${a.event === "leave" ? "beim Verlassen" : "beim Erreichen"} von ${a.zone}${a.repeat ? ", jedes Mal" : ", einmalig"}.`);
    })),

    tool("list_location_reminders", "Eigene aktive Orts-Erinnerungen.", {}, safe(async () => {
      const { data, error } = await db().from("location_reminders").select("id, zone, event, message, repeat").eq("user_id", ctx.user.id).eq("active", true);
      if (error) throw error;
      return ok(data ?? []);
    })),

    tool("delete_location_reminder", "Orts-Erinnerung löschen.", { id: z.string().uuid() }, safe(async (a) => {
      const { error } = await db().from("location_reminders").delete().eq("id", a.id).eq("user_id", ctx.user.id);
      if (error) throw error;
      return ok("Gelöscht");
    })),

    tool("list_calendars", "Verfügbare Kalender (Apple, Abos wie Abfuhrkalender, Home Assistant), wem sie gehören und ob man eintragen kann.", {}, safe(async () => {
      if (!ctx.calendar.enabled) return ok("Kein Kalender konfiguriert (icloud_*, calendar_feeds, ha_calendars).");
      return ok(await ctx.calendar.listCalendars());
    })),

    tool("list_events", "Termine in einem Zeitraum.", {
      from: z.string().describe("ISO-Datum/Zeit"),
      to: z.string().describe("ISO-Datum/Zeit"),
      calendars: z.array(z.string()).optional(),
    }, safe(async (a) => {
      if (!ctx.calendar.enabled) return ok("Kein Kalender konfiguriert.");
      const from = parseBerlin(a.from).toISOString(), to = parseBerlin(a.to).toISOString();
      const evs = await ctx.calendar.events(from, to, a.calendars);
      // Uhrzeit fertig in deutscher Zeit mitgeben, damit nichts umgerechnet werden muss
      return ok(evs.map(({ ref, ...e }) => ({
        ...e,
        // termin_id nur bei Apple-Terminen ohne Serie – damit lassen sie sich ändern/löschen
        termin_id: ref && !e.recurring ? Buffer.from(ref).toString("base64url") : undefined,
        wann: e.allDay ? `${e.start.slice(0, 10)} ganztägig` : `${berlinText(new Date(e.start))} Uhr${e.end ? ` bis ${berlinText(new Date(e.end)).slice(-5)} Uhr` : ""}`,
      })));
    })),

    tool("create_event", "Termin eintragen. Im eigenen oder gemeinsamen Kalender direkt (Stufe 1), im Kalender einer anderen Person nur nach Freigabe (Stufe 2).", {
      calendar: z.string(),
      title: z.string(),
      start: z.string().describe("ISO-Datum/Zeit mit Zeitzone, z. B. 2026-11-24T18:30:00+01:00"),
      end: z.string(),
      location: z.string().optional(),
      notes: z.string().optional(),
    }, safe(async (a) => {
      if (!ctx.calendar.apple.enabled) throw new Error("Apple-Kalender ist nicht konfiguriert – eintragen geht nur dort");
      const owner = ownerOf(a.calendar);
      const mine = owner === "shared" || owner?.toLowerCase() === ctx.user.name.toLowerCase();
      const ev = { calendar: a.calendar, title: a.title, start: berlinIso(parseBerlin(a.start)), end: berlinIso(parseBerlin(a.end)), location: a.location ?? null, notes: a.notes ?? null };
      if (mine) {
        await ctx.calendar.apple.createEvent(a.calendar, ev);
        return ok(`Termin „${a.title}“ eingetragen`);
      }
      const when = new Date(a.start).toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" });
      const r = await ctx.actions.request("calendar_event", ev, { agent: "family", summary: `${a.title}\n${when} in „${a.calendar}“`, requestedBy: ctx.user });
      return ok({ status: "Kalender einer anderen Person – Freigabe angefragt", an: r.approvers });
    })),

    tool("update_event", "Bestehenden Termin ändern (Zeit, Titel, Ort, Notiz) oder in einen anderen Kalender verschieben. termin_id aus list_events. Nur angegebene Felder ändern sich. Serientermine gehen nicht.", {
      termin_id: z.string().min(8),
      title: z.string().optional(),
      start: z.string().optional().describe("ISO-Zeit mit Zeitzone; ohne Zeitzone gilt deutsche Zeit"),
      end: z.string().optional(),
      location: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      calendar: z.string().optional().describe("Nur zum Verschieben in einen anderen Kalender"),
    }, safe(async (a) => {
      const ref = Buffer.from(a.termin_id, "base64url").toString("utf8");
      const cur = await ctx.calendar.apple.getEvent(ref);
      mayEdit(cur.calendar);
      if (a.calendar) mayEdit(a.calendar);
      let start: string, end: string;
      if (cur.allDay && !a.start) { start = cur.start; end = cur.end ?? cur.start; }
      else {
        const s0 = a.start ? parseBerlin(a.start) : new Date(cur.start);
        // Ohne neues Ende bleibt die Dauer gleich
        const dur = cur.end && !cur.allDay ? new Date(cur.end).getTime() - new Date(cur.start).getTime() : 3_600_000;
        const e0 = a.end ? parseBerlin(a.end) : new Date(s0.getTime() + dur);
        if (e0 < s0) throw new Error("Ende liegt vor dem Beginn");
        start = berlinIso(s0); end = berlinIso(e0);
      }
      const allDay = cur.allDay && !a.start;
      await ctx.calendar.apple.updateEvent(ref, {
        title: a.title ?? cur.title, start, end, allDay,
        location: a.location === undefined ? cur.location : a.location,
        notes: a.notes === undefined ? cur.notes ?? null : a.notes,
      }, a.calendar);
      const when = allDay ? `${start.slice(0, 10)} ganztägig` : `${berlinText(new Date(start))} Uhr`;
      return ok(`Termin „${a.title ?? cur.title}“ geändert: ${when}${a.calendar ? ` in „${a.calendar}“` : ""}`);
    })),

    tool("delete_event", "Termin löschen (termin_id aus list_events). Vorher kurz bestätigen lassen, welcher Termin gemeint ist. Serientermine gehen nicht.", {
      termin_id: z.string().min(8),
    }, safe(async (a) => {
      const ref = Buffer.from(a.termin_id, "base64url").toString("utf8");
      const cur = await ctx.calendar.apple.getEvent(ref);
      mayEdit(cur.calendar);
      await ctx.calendar.apple.deleteEvent(ref);
      return ok(`Termin „${cur.title}“ gelöscht`);
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

    tool("remind", "Sofort eine Push-Nachricht an eine Person aus dem Haushalt schicken (für spätere Zeitpunkte create_reminder).", {
      person: z.string().describe("Name laut Nutzerliste"),
      message: z.string(),
    }, safe(async (a) => {
      const { listUsers } = await import("../core/db.js");
      const data = (await listUsers()).find((u) => u.name.toLowerCase() === a.person.trim().toLowerCase());
      if (!data?.notify_service) throw new Error(`${a.person} ist nicht erreichbar (keine App und kein Benachrichtigungsdienst)`);
      await ctx.ha.notify(data.notify_service, `Erinnerung von ${ctx.user.name}`, a.message);
      return ok(`Erinnerung an ${data.name} geschickt`);
    })),

    tool("create_reminder", "Erinnerung zu einem Zeitpunkt anlegen, optional wiederkehrend. Standard: für die fragende Person. Für „in X Minuten/Stunden“ immer in_minutes nutzen statt selbst zu rechnen.", {
      message: z.string(),
      in_minutes: z.number().int().min(1).max(60 * 24 * 30).optional().describe("Relativ ab jetzt, z. B. 3 für „in 3 Minuten“"),
      at: z.string().optional().describe("Absolut: ISO-Zeit mit Zeitzone, z. B. 2026-11-23T08:00:00+01:00"),
      person: z.string().optional().describe("Name aus dem Haushalt, falls jemand anderes erinnert werden soll"),
      repeat: z.enum(["none", "daily", "weekly", "monthly", "yearly"]).default("none"),
    }, safe(async (a) => {
      const nowText = new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" });
      if (a.in_minutes === undefined && !a.at) throw new Error("in_minutes oder at angeben");
      const due = a.in_minutes !== undefined ? new Date(Date.now() + a.in_minutes * 60_000) : parseBerlin(a.at!);
      if (Number.isNaN(due.getTime())) throw new Error("Zeitpunkt nicht lesbar");
      // Schutz vor falsch berechneten Zeiten: Vergangenheit ablehnen statt still sofort auszulösen
      if (due.getTime() < Date.now() - 60_000) throw new Error(`Der Zeitpunkt liegt in der Vergangenheit – jetzt ist ${nowText}. Für „in X Minuten“ in_minutes verwenden.`);
      const target = a.person ? await findUser(a.person) : { id: ctx.user.id, name: ctx.user.name };
      if (ctx.user.role === "child" && target.id !== ctx.user.id) throw new Error("Kinder können nur sich selbst erinnern");
      const { data: row, error } = await db().from("reminders").insert({ user_id: target.id, message: a.message, due_at: due.toISOString(), repeat: a.repeat, created_by: ctx.user.id }).select("id").single();
      if (error) throw error;
      const when = due.toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" });
      return ok(`Erinnerung ${row.id} für ${target.name} am ${when}${a.repeat !== "none" ? ` (${a.repeat})` : ""} – kommt als Push. (Jetzt ist ${nowText}.)`);
    })),

    tool("list_reminders", "Offene Erinnerungen (eigene; Erwachsene sehen alle).", {}, safe(async () => {
      let q = db().from("reminders").select("id, message, due_at, repeat, user_id, users!reminders_user_id_fkey(name)").eq("done", false).order("due_at");
      if (ctx.user.role === "child") q = q.eq("user_id", ctx.user.id);
      const { data, error } = await q;
      if (error) throw error;
      return ok(data ?? []);
    })),

    tool("cancel_reminder", "Erinnerung löschen.", { id: z.string().uuid() }, safe(async (a) => {
      let q = db().from("reminders").update({ done: true }).eq("id", a.id);
      if (ctx.user.role === "child") q = q.eq("user_id", ctx.user.id);
      const { error } = await q;
      if (error) throw error;
      return ok("Erinnerung gelöscht");
    })),
  ];
}
