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
  async resolve(userId: string, requested?: string | null): Promise<Conversation> {
    for (const id of [requested, this.current()[userId]]) {
      if (!id) continue;
      const c = await this.get(id, userId);
      if (c) { this.setCurrent(userId, c.id); return c; }
    }
    const { data, error } = await db().from("conversations").insert({ user_id: userId }).select("id, user_id, title, session_id, updated_at").single();
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

  async setSession(conv: Conversation, sessionId: string): Promise<void> {
    conv.session_id = sessionId;
    await db().from("conversations").update({ session_id: sessionId }).eq("id", conv.id);
  }

  async list(userId: string, limit = 100) {
    const { data, error } = await db().from("conversations").select("id, title, updated_at, conversation_messages(count)")
      .eq("user_id", userId).order("updated_at", { ascending: false }).limit(limit);
    if (error) throw error;
    const current = this.current()[userId];
    return (data ?? [])
      .map((c) => ({ id: c.id, title: c.title, updated_at: c.updated_at, messages: (c.conversation_messages as unknown as { count: number }[])?.[0]?.count ?? 0, current: c.id === current }))
      .filter((c) => c.messages > 0);
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
