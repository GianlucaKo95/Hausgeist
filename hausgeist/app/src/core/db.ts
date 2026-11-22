import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "./config.js";
import type { AppUser } from "./checks.js";

let client: SupabaseClient | undefined;

export function db(config?: Config): SupabaseClient {
  if (!client) {
    if (!config) throw new Error("db() vor der Initialisierung aufgerufen");
    client = createClient(config.supabase_url, config.supabase_service_key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

let appPushEnabled = false;

/** Wird beim Start gesetzt, wenn APNs konfiguriert ist. */
export function enableAppPush(on: boolean): void {
  appPushEnabled = on;
}

/**
 * Nutzer des Haushalts. notify_service sagt, wie jemand erreichbar ist:
 * "app:<id>" (Hausgeist-App, ggf. mit "|<HA-Dienst>" als Rückfall) oder ein HA-Dienst.
 */
export async function listUsers(): Promise<AppUser[]> {
  const { data, error } = await db()
    .from("users")
    .select("id, name, role, approval_limit_cents, ha_user_id, notify_service");
  if (error) throw error;
  const users = data as AppUser[];
  if (!appPushEnabled) return users;
  const { data: devices } = await db().from("push_devices").select("user_id");
  const withApp = new Set((devices ?? []).map((d) => d.user_id as string));
  return users.map((u) => withApp.has(u.id)
    ? { ...u, notify_service: `app:${u.id}${u.notify_service ? `|${u.notify_service}` : ""}` }
    : u);
}

export async function audit(entry: {
  agent: string;
  action: string;
  level: 0 | 1 | 2 | 3;
  result: string;
  user_id?: string | null;
  ref_table?: string;
  ref_id?: string;
  detail?: unknown;
}): Promise<void> {
  const { error } = await db().from("audit_log").insert({ ...entry, detail: entry.detail ?? null });
  // Ein fehlender Protokolleintrag darf den Ablauf nicht stoppen, wird aber laut gemeldet.
  if (error) console.error("audit_log fehlgeschlagen:", error.message);
}
