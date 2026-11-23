import type { Config, MailboxConfig } from "../core/config.js";
import type { AppUser } from "../core/checks.js";
import type { HomeAssistant } from "../adapters/homeassistant.js";
import type { CalendarHub } from "../adapters/calendar.js";
import type { Paperless } from "../adapters/paperless.js";
import type { ActionService } from "../core/actions.js";
import type { FinanceAgent } from "../agents/finance.js";
import type { IntakeAgent } from "../agents/intake.js";
import type { ShoppingList } from "../core/shopping-list.js";
import { db } from "../core/db.js";

export interface ToolContext {
  config: Config;
  ha: HomeAssistant;
  calendar: CalendarHub;
  paperless: Paperless;
  actions: ActionService;
  finance: FinanceAgent;
  intake: IntakeAgent;
  shopping: ShoppingList;
  /** Die Person, für die der Master-Agent gerade arbeitet. */
  user: AppUser;
}

export type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
};

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Fehler in Tools werden dem Agenten als Text zurückgegeben statt den Lauf abzubrechen. */
export function safe<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(`Fehler: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

export function requireAdult(ctx: ToolContext): void {
  if (ctx.user.role === "child") throw new Error("Dafür fehlt die Berechtigung.");
}

export function requireAdmin(ctx: ToolContext): void {
  if (ctx.user.role !== "admin") throw new Error("Das darf nur der Admin.");
}

/** Person aus dem Haushalt per Name finden (ohne Groß-/Kleinschreibung). */
export async function findUser(name: string) {
  const { data } = await db().from("users").select("id, name, role, notify_service").ilike("name", name.trim()).maybeSingle();
  if (!data) throw new Error(`"${name}" gehört nicht zum Haushalt`);
  return data as { id: string; name: string; role: string; notify_service: string | null };
}

/**
 * Postfächer, die diese Person sehen darf: private nur der Besitzer,
 * gemeinsame alle Erwachsenen. Kinder sehen keine Postfächer.
 */
export async function visibleMailboxes(ctx: ToolContext, scope: "private" | "business"): Promise<MailboxConfig[]> {
  if (ctx.user.role === "child") return [];
  const { data } = await db().from("mailboxes").select("name, owner_id, visibility, scope");
  const meta = new Map((data ?? []).map((m) => [m.name as string, m]));
  return ctx.config.mailboxes.filter((mb) => {
    const m = meta.get(mb.name);
    if (!m || m.scope !== scope) return false;
    return m.visibility === "shared" || m.owner_id === ctx.user.id;
  });
}

export async function mailboxFor(ctx: ToolContext, scope: "private" | "business", name: string): Promise<MailboxConfig> {
  const mb = (await visibleMailboxes(ctx, scope)).find((m) => m.name === name);
  if (!mb) throw new Error(`Postfach "${name}" nicht verfügbar`);
  return mb;
}
