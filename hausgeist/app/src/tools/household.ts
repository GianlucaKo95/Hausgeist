import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { db } from "../core/db.js";
import { entityAllowed, isSensitiveHaService } from "../core/checks.js";
import { ok, safe, requireAdult, requireAdmin, type ToolContext } from "./context.js";
import { detectFromHa } from "../core/energy-detect.js";

export function householdTools(ctx: ToolContext) {
  const allowed = (id: string) => entityAllowed(id, ctx.config.ha_entities);

  return [
    tool("list_entities", "Freigegebene Home-Assistant-Geräte mit aktuellem Zustand.", {
      domain: z.string().optional().describe("z. B. climate, light, sensor"),
    }, safe(async (a) => {
      const states = await ctx.ha.states();
      return ok(states
        .filter((s) => allowed(s.entity_id) && (!a.domain || s.entity_id.startsWith(`${a.domain}.`)))
        .map((s) => ({ entity_id: s.entity_id, state: s.state, name: s.attributes.friendly_name ?? null, unit: s.attributes.unit_of_measurement ?? null })));
    })),

    tool("get_entity", "Zustand und Attribute eines freigegebenen Geräts.", { entity_id: z.string() }, safe(async (a) => {
      if (!allowed(a.entity_id)) throw new Error(`${a.entity_id} ist nicht freigegeben`);
      return ok(await ctx.ha.state(a.entity_id));
    })),

    tool("call_service", "Gerät steuern. Schlösser, Alarm, Rollläden/Tore, Sirenen und Ventile gehen immer zur Freigabe (Stufe 2), alles andere wird direkt ausgeführt.", {
      domain: z.string(), service: z.string(), entity_id: z.string(),
      data: z.record(z.string(), z.unknown()).optional(),
    }, safe(async (a) => {
      requireAdult(ctx);
      if (!allowed(a.entity_id)) throw new Error(`${a.entity_id} ist nicht freigegeben`);
      if (!a.entity_id.startsWith(`${a.domain}.`) && a.domain !== "homeassistant")
        throw new Error("Domain und entity_id passen nicht zusammen");
      if (isSensitiveHaService(a.domain) || isSensitiveHaService(a.entity_id.split(".")[0])) {
        if (ctx.user.role === "family") throw new Error("Schlösser, Alarm, Tore und Ähnliches lassen sich über den Familienplaner nicht steuern – bitte in der Hausgeist-App.");
        const r = await ctx.actions.request("ha_service", { domain: a.domain, service: a.service, entity_id: a.entity_id, data: a.data ?? {} },
          { agent: "household", summary: `${a.domain}.${a.service} → ${a.entity_id}`, requestedBy: ctx.user });
        return ok({ status: "Sicherheitsrelevant – Freigabe angefragt", an: r.approvers });
      }
      await ctx.ha.callService(a.domain, a.service, { entity_id: a.entity_id, ...(a.data ?? {}) });
      return ok(`${a.domain}.${a.service} für ${a.entity_id} ausgeführt`);
    })),

    tool("energy_status", "Aktuelle Werte von PV, Batteriespeicher, Netz und Hausverbrauch.", {}, safe(async () => {
      const out: Record<string, unknown> = {};
      for (const [key, id] of Object.entries(ctx.config.energy)) {
        if (!id) continue;
        const s = await ctx.ha.state(id);
        out[key] = s ? { entity_id: id, value: s.state, unit: s.attributes.unit_of_measurement ?? null } : { entity_id: id, value: null };
      }
      if (Object.keys(out).length === 0) return ok("Keine Energiesensoren eingerichtet – mit detect_energy_sensors suchen.");
      return ok(out);
    })),

    tool("detect_energy_sensors", "Energie-Sensoren (PV, Speicher, Netz, Hausverbrauch) selbst in Home Assistant finden – über das Energie-Dashboard und Gerätenamen. Mit apply=true übernehmen (nur Admin).", {
      apply: z.boolean().default(false),
    }, safe(async (a) => {
      const r = await detectFromHa(ctx.ha);
      if (a.apply) {
        requireAdmin(ctx);
        await ctx.saveSettings({ energy: r.pick });
      }
      return ok({ übernommen: a.apply, auswahl: r.pick, quelle: r.fromDashboard ? "Energie-Dashboard + Gerät" : "Namensregeln", alternativen: r.candidates });
    })),

    tool("energy_history", "Verlauf eines Energiesensors der letzten Stunden, z. B. um Lastverschiebung zu planen.", {
      sensor: z.enum(["pv_power", "battery_soc", "battery_power", "grid_power", "house_power"]),
      hours: z.number().int().min(1).max(168).default(24),
    }, safe(async (a) => {
      const id = ctx.config.energy[a.sensor];
      if (!id) throw new Error(`${a.sensor} ist nicht konfiguriert`);
      const h = await ctx.ha.history(id, a.hours);
      // Auf höchstens ~100 Punkte ausdünnen
      const step = Math.max(1, Math.ceil(h.length / 100));
      return ok(h.filter((_, i) => i % step === 0).map((p) => ({ t: p.last_changed, v: p.state })));
    })),

    tool("list_chores", "Haushaltsaufgaben und Wartungen.", { due_within_days: z.number().int().optional() }, safe(async (a) => {
      let q = db().from("chores").select("id, title, interval_days, next_due, last_done, assignee_id, notes").order("next_due");
      if (a.due_within_days != null) q = q.lte("next_due", new Date(Date.now() + a.due_within_days * 86_400_000).toISOString().slice(0, 10));
      const { data, error } = await q;
      if (error) throw error;
      return ok(data ?? []);
    })),

    tool("save_chore", "Haushaltsaufgabe oder Wartung anlegen, z. B. Filterwechsel alle 90 Tage (Stufe 1).", {
      title: z.string(),
      interval_days: z.number().int().positive().optional(),
      next_due: z.string().describe("JJJJ-MM-TT"),
      assignee_name: z.string().optional(),
      notes: z.string().optional(),
    }, safe(async (a) => {
      let assignee: string | null = null;
      if (a.assignee_name) {
        const { data } = await db().from("users").select("id").ilike("name", a.assignee_name).maybeSingle();
        assignee = data?.id ?? null;
      }
      const { error } = await db().from("chores").insert({ title: a.title, interval_days: a.interval_days ?? null, next_due: a.next_due, assignee_id: assignee, notes: a.notes ?? null });
      if (error) throw error;
      return ok("Aufgabe angelegt");
    })),

    tool("complete_chore", "Aufgabe erledigt – bei Wiederholung wird der nächste Termin berechnet.", { id: z.string().uuid() }, safe(async (a) => {
      const { data: c, error } = await db().from("chores").select("interval_days").eq("id", a.id).single();
      if (error) throw error;
      const today = new Date().toISOString().slice(0, 10);
      const next = c.interval_days ? new Date(Date.now() + c.interval_days * 86_400_000).toISOString().slice(0, 10) : null;
      await db().from("chores").update({ last_done: today, next_due: next }).eq("id", a.id);
      return ok(next ? `Erledigt, nächstes Mal am ${next}` : "Erledigt");
    })),

    tool("list_areas", "Räume/Bereiche aus Home Assistant mit den freigegebenen Geräten darin, z. B. für „alle Lichter im Wohnzimmer“.", {}, safe(async () => {
      const areas = await ctx.ha.areas();
      return ok(areas.map((a) => ({ area: a.area, entities: a.entities.filter(allowed) })).filter((a) => a.entities.length > 0));
    })),

    tool("schedule_device_action", "Gerät zu einem Zeitpunkt schalten, optional wiederkehrend (z. B. Waschmaschine um 13 Uhr, wenn PV-Überschuss erwartet wird). Sicherheitsrelevante Geräte können nicht geplant werden.", {
      run_at: z.string().describe("ISO-Zeit mit Zeitzone"),
      repeat: z.enum(["none", "daily", "weekdays", "weekly"]).default("none"),
      domain: z.string(), service: z.string(), entity_id: z.string(),
      data: z.record(z.string(), z.unknown()).optional(),
      label: z.string().optional(),
    }, safe(async (a) => {
      requireAdult(ctx);
      if (!allowed(a.entity_id)) throw new Error(`${a.entity_id} ist nicht freigegeben`);
      if (isSensitiveHaService(a.domain) || isSensitiveHaService(a.entity_id.split(".")[0]))
        throw new Error("Sicherheitsrelevante Geräte (Schlösser, Alarm, Tore …) werden nicht zeitgesteuert geschaltet");
      const at = new Date(a.run_at);
      if (Number.isNaN(at.getTime())) throw new Error("Zeitpunkt nicht lesbar");
      const { error } = await db().from("scheduled_actions").insert({
        run_at: at.toISOString(), repeat: a.repeat, domain: a.domain, service: a.service, entity_id: a.entity_id,
        data: a.data ?? {}, label: a.label ?? null, created_by: ctx.user.id,
      });
      if (error) throw error;
      return ok(`Geplant: ${a.domain}.${a.service} → ${a.entity_id} am ${at.toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" })}${a.repeat !== "none" ? ` (${a.repeat})` : ""}`);
    })),

    tool("list_scheduled_actions", "Geplante Schaltungen.", {}, safe(async () => {
      const { data, error } = await db().from("scheduled_actions").select("id, run_at, repeat, domain, service, entity_id, label, last_run, last_result").eq("active", true).order("run_at");
      if (error) throw error;
      return ok(data ?? []);
    })),

    tool("cancel_scheduled_action", "Geplante Schaltung löschen.", { id: z.string().uuid() }, safe(async (a) => {
      requireAdult(ctx);
      await db().from("scheduled_actions").update({ active: false }).eq("id", a.id);
      return ok("Gelöscht");
    })),

    tool("create_alert", "Geräteüberwachung: melden, wenn ein Wert unter/über einer Schwelle liegt, einen Zustand hat oder das Gerät nicht erreichbar ist – optional mit Schaltung. Beispiele: Waschmaschine fertig (Leistung unter 5 W für 3 Minuten), Gerät offline, Speicher über 95 % → Waschmaschine einschalten.", {
      entity_id: z.string(),
      condition: z.enum(["below", "above", "equals", "unavailable"]),
      value: z.string().optional().describe("Schwelle (Zahl) oder Zustand, bei unavailable leer"),
      for_minutes: z.number().int().min(0).default(0),
      message: z.string(),
      notify: z.array(z.string()).default([]).describe("Namen; leer = alle Erwachsenen"),
      action: z.object({ domain: z.string(), service: z.string(), entity_id: z.string(), data: z.record(z.string(), z.unknown()).optional() }).optional(),
    }, safe(async (a) => {
      requireAdult(ctx);
      if (!allowed(a.entity_id)) throw new Error(`${a.entity_id} ist nicht freigegeben`);
      if ((a.condition === "below" || a.condition === "above") && (a.value == null || Number.isNaN(Number(a.value))))
        throw new Error("Für below/above wird eine Zahl als value gebraucht");
      if (a.action) {
        if (!allowed(a.action.entity_id)) throw new Error(`${a.action.entity_id} ist nicht freigegeben`);
        if (isSensitiveHaService(a.action.domain) || isSensitiveHaService(a.action.entity_id.split(".")[0]))
          throw new Error("Sicherheitsrelevante Geräte können nicht automatisch geschaltet werden");
      }
      const { error } = await db().from("alerts").insert({
        entity_id: a.entity_id, condition: a.condition, value: a.value ?? null, for_minutes: a.for_minutes,
        message: a.message, notify: a.notify, action: a.action ?? null, created_by: ctx.user.id,
      });
      if (error) throw error;
      return ok("Überwachung angelegt");
    })),

    tool("list_alerts", "Aktive Geräteüberwachungen.", {}, safe(async () => {
      const { data, error } = await db().from("alerts").select("id, entity_id, condition, value, for_minutes, message, notify, action, triggered, last_fired").eq("active", true);
      if (error) throw error;
      return ok(data ?? []);
    })),

    tool("delete_alert", "Überwachung beenden.", { id: z.string().uuid() }, safe(async (a) => {
      requireAdult(ctx);
      await db().from("alerts").update({ active: false }).eq("id", a.id);
      return ok("Beendet");
    })),
  ];
}
