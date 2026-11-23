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
  smtp_host: z.string().optional(),
  smtp_port: z.number().int().optional(),
  from_name: z.string().optional(),
});

const Calendar = z.object({ name: z.string(), owner: z.string() });
const CalendarFeed = z.object({ name: z.string(), url: z.string(), owner: z.string().default("shared") });
const HaCalendar = z.object({ name: z.string(), entity_id: z.string().regex(/^calendar\.[a-z0-9_]+$/), owner: z.string().default("shared") });

const Energy = z.object({
  pv_power: z.string().optional(),
  battery_soc: z.string().optional(),
  battery_power: z.string().optional(),
  grid_power: z.string().optional(),
  house_power: z.string().optional(),
});

export const Options = z.object({
  anthropic_api_key: z.string().min(1, "anthropic_api_key fehlt"),
  model: z.string().default("claude-sonnet-5-5"),
  supabase_url: z.string().url(),
  supabase_service_key: z.string().min(1, "supabase_service_key fehlt"),
  paperless_url: z.string().default(""),
  paperless_token: z.string().default(""),
  payment_mode: z.enum(["dryrun", "fints"]).default("dryrun"),
  mailboxes: z.array(Mailbox).default([]),
  icloud_user: z.string().default(""),
  icloud_app_password: z.string().default(""),
  calendars: z.array(Calendar).default([]),
  calendar_feeds: z.array(CalendarFeed).default([]),
  ha_calendars: z.array(HaCalendar).default([]),
  calendar_insights: z.boolean().default(true),
  evening_check: z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d)?$/, "evening_check im Format HH:MM").default("18:00"),
  ha_entities: z.array(z.string()).default([]),
  energy: Energy.default({}),
  github_token: z.string().default(""),
  serpapi_key: z.string().default(""),
  apns_key_id: z.string().default(""),
  apns_team_id: z.string().default(""),
  apns_key: z.string().default(""),
  apns_bundle_id: z.string().default("de.koeven.hausgeist"),
  daily_brief: z
    .string()
    .regex(/^(([01]\d|2[0-3]):[0-5]\d)?$/, "daily_brief im Format HH:MM")
    .default("07:30"),
  mail_triage: z.boolean().default(true),
  weekly_offers: z.boolean().default(true),
  log_level: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type MailboxConfig = z.infer<typeof Mailbox>;
export type CalendarConfig = z.infer<typeof Calendar>;
export type Config = z.infer<typeof Options> & {
  dataDir: string;
  supervisorToken: string | undefined;
  haBaseUrl: string;
  haWsUrl: string;
};

/** Felder, die in der App gepflegt werden können – ohne Standardwerte, damit nur Gesendetes gilt. */
const time = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d)?$/, "Uhrzeit im Format HH:MM");
export const AppSettings = z.object({
  mailboxes: z.array(Mailbox),
  icloud_user: z.string(),
  icloud_app_password: z.string(),
  calendars: z.array(Calendar),
  calendar_feeds: z.array(CalendarFeed),
  ha_calendars: z.array(HaCalendar),
  ha_entities: z.array(z.string()),
  energy: Energy,
  daily_brief: time,
  evening_check: time,
  mail_triage: z.boolean(),
  weekly_offers: z.boolean(),
  calendar_insights: z.boolean(),
  paperless_url: z.string(),
  paperless_token: z.string(),
}).partial();
export type AppSettings = z.infer<typeof AppSettings>;

export function settingsPath(dataDir: string): string {
  return `${dataDir.replace(/\/$/, "")}/settings.json`;
}

export function readAppSettings(dataDir: string): AppSettings {
  const p = settingsPath(dataDir);
  if (!existsSync(p)) return {};
  const parsed = AppSettings.safeParse(JSON.parse(readFileSync(p, "utf8")));
  return parsed.success ? parsed.data : {};
}

/** Liest /data/options.json (Home-Assistant-Add-on) oder für lokale Tests HAUSGEIST_OPTIONS. */
export function loadConfig(): Config {
  const path = process.env.HAUSGEIST_OPTIONS ?? "/data/options.json";
  if (!existsSync(path)) throw new Error(`Konfiguration nicht gefunden: ${path}`);
  const options = Options.parse(JSON.parse(readFileSync(path, "utf8")));
  const supervisorToken = process.env.SUPERVISOR_TOKEN;
  const dataDir = process.env.HAUSGEIST_DATA ?? "/data";
  // In der App gepflegte Einstellungen (inkl. Passwörter) liegen nur auf dem Pi
  // in /data/settings.json und haben Vorrang vor der Add-on-Konfiguration.
  const overlay = readAppSettings(dataDir);
  return {
    ...options,
    ...overlay,
    dataDir,
    supervisorToken,
    // Im Add-on erreicht man Home Assistant über den Supervisor-Proxy.
    haBaseUrl: process.env.HA_URL ?? "http://supervisor/core/api",
    haWsUrl: process.env.HA_WS_URL ?? "ws://supervisor/core/websocket",
  };
}
