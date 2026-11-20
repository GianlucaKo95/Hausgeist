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

export async function listUsers(): Promise<AppUser[]> {
  const { data, error } = await db()
    .from("users")
    .select("id, name, role, approval_limit_cents, ha_user_id, notify_service");
  if (error) throw error;
  return data as AppUser[];
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
