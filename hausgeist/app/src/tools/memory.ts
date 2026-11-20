import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { db } from "../core/db.js";
import { ok, safe, type ToolContext } from "./context.js";

/** Werkzeuge des Master-Agenten: Präferenzen, laufende Aufgaben, Rechercheablage. */
export function memoryTools(ctx: ToolContext) {
  return [
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
