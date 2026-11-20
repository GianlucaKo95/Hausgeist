import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";

const Mailbox = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number().int(),
  tls: z.boolean(),
  user: z.string(),
  password: z.string(),
  folder: z.string().optional(),
});

const Options = z.object({
  anthropic_api_key: z.string().min(1, "anthropic_api_key fehlt"),
  model: z.string().default("claude-sonnet-5-5"),
  supabase_url: z.string().url(),
  supabase_service_key: z.string().min(1, "supabase_service_key fehlt"),
  paperless_url: z.string().default(""),
  paperless_token: z.string().default(""),
  payment_mode: z.enum(["dryrun", "fints"]).default("dryrun"),
  mailboxes: z.array(Mailbox).default([]),
  log_level: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type MailboxConfig = z.infer<typeof Mailbox>;
export type Config = z.infer<typeof Options> & {
  dataDir: string;
  supervisorToken: string | undefined;
  haBaseUrl: string;
  haWsUrl: string;
};

/** Liest /data/options.json (Home-Assistant-Add-on) oder für lokale Tests HAUSGEIST_OPTIONS. */
export function loadConfig(): Config {
  const path = process.env.HAUSGEIST_OPTIONS ?? "/data/options.json";
  if (!existsSync(path)) throw new Error(`Konfiguration nicht gefunden: ${path}`);
  const options = Options.parse(JSON.parse(readFileSync(path, "utf8")));
  const supervisorToken = process.env.SUPERVISOR_TOKEN;
  return {
    ...options,
    dataDir: process.env.HAUSGEIST_DATA ?? "/data",
    supervisorToken,
    // Im Add-on erreicht man Home Assistant über den Supervisor-Proxy.
    haBaseUrl: process.env.HA_URL ?? "http://supervisor/core/api",
    haWsUrl: process.env.HA_WS_URL ?? "ws://supervisor/core/websocket",
  };
}
