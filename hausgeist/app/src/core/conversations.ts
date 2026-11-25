import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db.js";

export interface Conversation { id: string; user_id: string; title: string; session_id: string | null; updated_at: string }
export type Sender = "me" | "ghost" | "error";

/**
 * Gesprächsverlauf in Supabase. Je Person gibt es ein „aktuelles“ Gespräch, in das neue
 * Nachrichten (auch von Siri) laufen; „Neu“ beginnt ein frisches, alte lassen sich wieder öffnen.
 */
export class Conversations {
  private readonly currentPath: string;

  constructor(dataDir: string) {
    this.currentPath = join(dataDir, "current-conversation.json");
  }

  private current(): Record<string, string> {
    try { return existsSync(this.currentPath) ? JSON.parse(readFileSync(this.currentPath, "utf8")) : {}; } catch { return {}; }
  }
  private setCurrent(userId: string, convId: string | null): void {
    const c = this.current();
    if (convId) c[userId] = convId; else delete c[userId];
    writeFileSync(this.currentPath, JSON.stringify(c));
  }

  async get(id: string, userId: string): Promise<Conversation | null> {
    const { data } = await db().from("conversations").select("id, user_id, title, session_id, updated_at").eq("id", id).eq("user_id", userId).maybeSingle();
    return (data as Conversation) ?? null;
  }

  /** Gewünschtes Gespräch (falls es der Person gehört), sonst das aktuelle, sonst ein neues. */
  async resolve(userId: string, requested?: string | null, legacySession?: () => string | undefined): Promise<Conversation> {
    for (const id of [requested, this.current()[userId]]) {
      if (!id) continue;
      const c = await this.get(id, userId);
      if (c) { this.setCurrent(userId, c.id); return c; }
    }
    // Erstes Gespräch nach dem Umstieg: laufende Sitzung von vorher übernehmen, damit nichts verloren geht.
    const { data, error } = await db().from("conversations").insert({ user_id: userId, session_id: legacySession?.() ?? null }).select("id, user_id, title, session_id, updated_at").single();
    if (error) throw error;
    this.setCurrent(userId, data.id);
    return data as Conversation;
  }

  startNew(userId: string): void {
    this.setCurrent(userId, null);
  }

  async add(conv: Conversation, sender: Sender, text: string): Promise<void> {
    await db().from("conversation_messages").insert({ conversation_id: conv.id, sender, text: text.slice(0, 50_000) });
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (sender === "me" && conv.title === "Neues Gespräch" && text.trim()) {
      const t = text.trim().replace(/\s+/g, " ");
      patch.title = t.length > 60 ? `${t.slice(0, 57)}…` : t;
      conv.title = patch.title as string;
    }
    await db().from("conversations").update(patch).eq("id", conv.id);
  }

  /**
   * Themen-Titel wie bei Claude: nach der ersten Antwort (und nach einigen Nachrichten noch einmal)
   * fasst ein kleines Modell das Thema in wenigen Worten zusammen. Der Bereich ergibt sich aus dem
   * Fach-Agenten, der am meisten beteiligt war.
   */
  async autoTitle(conv: Conversation, config: Config, agents: string[], force = false): Promise<void> {
    const { data: row } = await db().from("conversations").select("titled, category, conversation_messages(count)").eq("id", conv.id).maybeSingle();
    const count = (row?.conversation_messages as unknown as { count: number }[])?.[0]?.count ?? 0;
    const patch: Record<string, unknown> = {};
    // Bereich: aus den beteiligten Fach-Agenten (einmal festgelegt, dann stabil)
    if (!row?.category && agents.length) patch.category = categoryOf(agents);
    // erster Titel nach der ersten Antwort, einmal verfeinern nach 6 Nachrichten
    if (force || !row?.titled || count === 6) {
      const text = await this.historyText(conv.id);
      if (!text.trim()) return;
      try {
        const client = new Anthropic({ apiKey: config.anthropic_api_key });
        const r = await client.messages.create({
          model: config.light_model, max_tokens: 60,
          system: `Gib einem Chat einen kurzen deutschen Themen-Titel (2–5 Wörter, wie eine Überschrift, kein Satz) und ordne ihn einem Bereich zu.
Bereiche: ${[...new Set(Object.values(CATEGORY)), "Trading", "Allgemein"].join(", ")}.
Antworte nur mit JSON: {"titel":"…","bereich":"…"}. Beispiele für Titel: „Elternabend Termin“, „Stromrechnung Oktober“, „Laptop: Chrome installieren“.`,
          messages: [{ role: "user", content: text.slice(-4000) }],
        });
        const raw = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { titel?: string; bereich?: string };
        const t = String(j.titel ?? "").trim().replace(/^["„“']+|["„“'.]+$/g, "").slice(0, 60);
        if (t) { patch.title = t; patch.titled = true; conv.title = t; }
        if (!row?.category && !patch.category && j.bereich) patch.category = String(j.bereich).slice(0, 40);
      } catch { /* Titel ist Komfort */ }
    }
    if (Object.keys(patch).length) await db().from("conversations").update(patch).eq("id", conv.id);
  }

  /** Ältere Gespräche einmalig mit Themen-Titel und Bereich versehen. */
  async backfillTitles(config: Config, limit = 60): Promise<void> {
    const { data } = await db().from("conversations").select("id, user_id, title, session_id, updated_at").eq("titled", false).order("updated_at", { ascending: false }).limit(limit);
    for (const c of data ?? []) await this.autoTitle(c as Conversation, config, [], true).catch(() => undefined);
  }

  async setSession(conv: Conversation, sessionId: string): Promise<void> {
    conv.session_id = sessionId;
    await db().from("conversations").update({ session_id: sessionId }).eq("id", conv.id);
  }

  async list(userId: string, limit = 100) {
    const { data, error } = await db().from("conversations").select("id, title, category, updated_at, conversation_messages(count)")
      .eq("user_id", userId).order("updated_at", { ascending: false }).limit(limit);
    if (error) throw error;
    const current = this.current()[userId];
    return (data ?? [])
      .map((c) => ({ id: c.id, title: c.title, category: c.category ?? "Allgemein", updated_at: c.updated_at, messages: (c.conversation_messages as unknown as { count: number }[])?.[0]?.count ?? 0, current: c.id === current }))
      .filter((c) => c.messages > 0);
  }

  /** Letzte Nachrichten als Text (für den Fall, dass die Agent-Sitzung nicht fortgesetzt werden kann). */
  async historyText(convId: string, limit = 20): Promise<string> {
    const { data } = await db().from("conversation_messages").select("sender, text, created_at")
      .eq("conversation_id", convId).order("created_at", { ascending: false }).limit(limit + 1);
    const rows = (data ?? []).reverse().slice(0, -1); // die gerade gesendete Nachricht weglassen
    return rows.map((r) => `${r.sender === "me" ? "Person" : r.sender === "ghost" ? "Hausgeist" : "Fehler"}: ${String(r.text).slice(0, 2000)}`).join("\n");
  }

  async messages(id: string, userId: string) {
    if (!(await this.get(id, userId))) return null;
    const { data, error } = await db().from("conversation_messages").select("id, sender, text, created_at").eq("conversation_id", id).order("created_at");
    if (error) throw error;
    return data ?? [];
  }

  async remove(id: string, userId: string): Promise<boolean> {
    const { data } = await db().from("conversations").delete().eq("id", id).eq("user_id", userId).select("id");
    if (this.current()[userId] === id) this.setCurrent(userId, null);
    return Boolean(data?.length);
  }
}

/** Bereich eines Gesprächs nach Fach-Agent (häufigster gewinnt). */
const CATEGORY: Record<string, string> = {
  finance: "Finanzen", document: "Dokumente", shopping: "Einkauf", communication: "Mail",
  household: "Haus", tv: "Fernseher", family: "Familie & Kalender", business: "Business",
  it: "IT & Computer", research: "Recherche",
};
export function categoryOf(agents: string[]): string {
  const counts = new Map<string, number>();
  for (const a of agents) if (CATEGORY[a]) counts.set(CATEGORY[a], (counts.get(CATEGORY[a]) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Allgemein";
}
