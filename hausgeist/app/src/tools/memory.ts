import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { db } from "../core/db.js";
import { ok, safe, type ToolContext } from "./context.js";

/** Werkzeuge des Master-Agenten: Präferenzen, laufende Aufgaben, Rechercheablage. */
export function memoryTools(ctx: ToolContext) {
  return [
    tool("remember", "Etwas dauerhaft über die Person merken (gilt in allen künftigen Gesprächen). Für ausdrückliche Bitten wie „merk dir …“. Keine Passwörter, PINs oder Kontonummern.", {
      fact: z.string().min(3).max(300),
    }, safe(async (a) => {
      if (/(passwort|kennwort|pin\b|tan\b|iban|kontonummer)/i.test(a.fact)) throw new Error("Zugangsdaten und Kontonummern merke ich mir nicht im Gedächtnis.");
      const { error } = await db().from("memories").insert({ user_id: ctx.user.id, text: a.fact });
      if (error) throw error;
      return ok("Gemerkt – gilt ab jetzt in jedem Gespräch.");
    })),

    tool("recall", "Gedächtnis durchsuchen (leer = alles), z. B. wenn die Person fragt „was weißt du über …“.", {
      query: z.string().default(""),
    }, safe(async (a) => {
      let q = db().from("memories").select("id, text, updated_at").eq("user_id", ctx.user.id).order("updated_at", { ascending: false }).limit(200);
      if (a.query) q = q.ilike("text", `%${a.query}%`);
      const { data, error } = await q;
      if (error) throw error;
      return ok(data ?? []);
    })),

    tool("forget", "Einen gemerkten Fakt löschen (id aus recall), z. B. bei „vergiss das“.", {
      id: z.string().uuid(),
    }, safe(async (a) => {
      const { error } = await db().from("memories").delete().eq("id", a.id).eq("user_id", ctx.user.id);
      if (error) throw error;
      return ok("Vergessen");
    })),

    tool("remember_preference", "Eine Vorliebe oder Arbeitsweise dauerhaft speichern – nur was die Person ausdrücklich sagt.", {
      key: z.string().describe("kurzer Schlüssel, z. B. einkauf.supermarkt"),
      value: z.string(),
      household: z.boolean().default(false).describe("true = gilt für den ganzen Haushalt"),
    }, safe(async (a) => {
      const { error } = await db().from("preferences").upsert(
        { user_id: a.household ? null : ctx.user.id, key: a.key, value: a.value, updated_at: new Date().toISOString() },
        { onConflict: "user_id,key" },
      );
      if (error) throw error;
      return ok("Gespeichert");
    })),

    tool("forget_preference", "Gespeicherte Vorliebe löschen.", { key: z.string(), household: z.boolean().default(false) }, safe(async (a) => {
      let q = db().from("preferences").delete().eq("key", a.key);
      q = a.household ? q.is("user_id", null) : q.eq("user_id", ctx.user.id);
      const { error } = await q;
      if (error) throw error;
      return ok("Gelöscht");
    })),

    tool("list_tasks", "Laufende Aufgaben, die der Master-Agent verfolgt.", { include_done: z.boolean().default(false) }, safe(async (a) => {
      let q = db().from("tasks").select("id, agent, title, status, data, updated_at").order("updated_at", { ascending: false }).limit(50);
      if (!a.include_done) q = q.in("status", ["open", "waiting"]);
      const { data, error } = await q;
      if (error) throw error;
      return ok(data ?? []);
    })),

    tool("track_task", "Aufgabe anlegen oder aktualisieren, um sie über mehrere Gespräche zu verfolgen.", {
      id: z.string().uuid().optional(),
      agent: z.string(),
      title: z.string(),
      status: z.enum(["open", "waiting", "done", "failed"]).default("open"),
      notes: z.string().optional(),
    }, safe(async (a) => {
      const row = { agent: a.agent, title: a.title, status: a.status, data: { notes: a.notes ?? null }, updated_at: new Date().toISOString() };
      const q = a.id ? db().from("tasks").update(row).eq("id", a.id) : db().from("tasks").insert({ ...row, created_by: ctx.user.id });
      const { data, error } = await q.select("id").single();
      if (error) throw error;
      return ok({ id: data.id });
    })),
  ];
}

export function noteTools(ctx: ToolContext) {
  return [
    tool("save_note", "Haushaltswissen speichern, z. B. 'Haupthahn: Keller links' oder 'Gäste-WLAN'. Private Notizen sieht nur die eigene Person.", {
      title: z.string(), content: z.string(), private: z.boolean().default(false), id: z.string().uuid().optional(),
    }, safe(async (a) => {
      const row = { title: a.title, content: a.content, private: a.private, owner_id: ctx.user.id, updated_at: new Date().toISOString() };
      const q = a.id ? db().from("notes").update(row).eq("id", a.id).or(`private.eq.false,owner_id.eq.${ctx.user.id}`) : db().from("notes").insert(row);
      const { error } = await q;
      if (error) throw error;
      return ok("Notiz gespeichert");
    })),

    tool("find_notes", "Notizen durchsuchen (leer = alle).", { query: z.string().default("") }, safe(async (a) => {
      const term = a.query.replace(/[%,()]/g, "");
      let q = db().from("notes").select("id, title, content, private, updated_at").or(`private.eq.false,owner_id.eq.${ctx.user.id}`).order("updated_at", { ascending: false }).limit(20);
      if (term) q = q.or(`title.ilike.%${term}%,content.ilike.%${term}%`);
      const { data, error } = await q;
      if (error) throw error;
      return ok(data ?? []);
    })),

    tool("delete_note", "Notiz löschen.", { id: z.string().uuid() }, safe(async (a) => {
      const { error } = await db().from("notes").delete().eq("id", a.id).or(`private.eq.false,owner_id.eq.${ctx.user.id}`);
      if (error) throw error;
      return ok("Gelöscht");
    })),
  ];
}

export function researchTools(ctx: ToolContext) {
  return [
    tool("save_research", "Ergebnis einer Recherche oder Entscheidungsvorlage mit Quellen ablegen.", {
      topic: z.string(),
      summary: z.string(),
      sources: z.array(z.object({ title: z.string(), url: z.string() })).default([]),
    }, safe(async (a) => {
      const { data, error } = await db().from("research_notes").insert({ ...a, requested_by: ctx.user.id }).select("id").single();
      if (error) throw error;
      return ok({ id: data.id });
    })),

    tool("find_research", "Frühere Recherchen zu einem Thema finden.", { query: z.string() }, safe(async (a) => {
      const { data, error } = await db().from("research_notes").select("id, topic, summary, sources, created_at")
        .or(`topic.ilike.%${a.query.replace(/[%,()]/g, "")}%,summary.ilike.%${a.query.replace(/[%,()]/g, "")}%`)
        .order("created_at", { ascending: false }).limit(10);
      if (error) throw error;
      return ok(data ?? []);
    })),
  ];
}
