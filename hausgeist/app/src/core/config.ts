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

export const BANKS = ["sparkasse_duisburg", "deutsche_bank", "dkb"] as const;
export type BankKey = (typeof BANKS)[number];
const BankLogin = z.object({
  login: z.string().min(1),
  pin: z.string().min(1),
  url: z.string().url().optional(),
});
export type BankLoginConfig = z.infer<typeof BankLogin>;
const BankLogins = z.object({
  sparkasse_duisburg: BankLogin.optional(),
  deutsche_bank: BankLogin.optional(),
  dkb: BankLogin.optional(),
});

const FritzBoxCfg = z.object({
  host: z.string().default("fritz.box"),
  user: z.string().default(""),
  password: z.string().default(""),
});
const PcCfg = z.object({
  name: z.string().default("PC"),
  host: z.string().default(""),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().default(""),
  mac: z.string().default(""),
});

const BringAccount = z.object({ email: z.string().default(""), password: z.string().default("") });
const BringList = z.object({
  name: z.string().min(1),
  /** Direkt bei Bring! (bevorzugt) … */
  list_uuid: z.string().optional(),
  /** … oder über die Home-Assistant-Integration */
  entity_id: z.string().regex(/^todo\.[a-z0-9_]+$/, "entity_id muss mit todo. beginnen").optional(),
  stores: z.array(z.string()).default([]),
  default: z.boolean().default(false),
});

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
  /** Kleines Modell fürs Langzeitgedächtnis (läuft nach jeder Antwort im Hintergrund) */
  memory_model: z.string().default("claude-haiku-5-5"),
  supabase_url: z.string().url(),
  supabase_service_key: z.string().min(1, "supabase_service_key fehlt"),
  paperless_url: z.string().default(""),
  paperless_token: z.string().default(""),
  payment_mode: z.enum(["dryrun", "fints"]).default("dryrun"),
  fints_product_id: z.string().default(""),
  bank_logins: BankLogins.default({}),
  mailboxes: z.array(Mailbox).default([]),
  icloud_user: z.string().default(""),
  icloud_app_password: z.string().default(""),
  calendars: z.array(Calendar).default([]),
  calendar_feeds: z.array(CalendarFeed).default([]),
  ha_calendars: z.array(HaCalendar).default([]),
  calendar_insights: z.boolean().default(true),
  departure_alerts: z.boolean().default(true),
  departure_buffer_min: z.number().int().min(0).max(60).default(10),
  travel_mode: z.enum(["car", "bike", "foot"]).default("car"),
  evening_check: z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d)?$/, "evening_check im Format HH:MM").default("18:00"),
  ha_entities: z.array(z.string()).default([]),
  bring_lists: z.array(BringList).default([]),
  bring: BringAccount.prefault({}),
  fritzbox: FritzBoxCfg.prefault({}),
  pc: PcCfg.prefault({}),
  energy: Energy.default({}),
  github_token: z.string().default(""),
  serpapi_key: z.string().default(""),
  apns_key_id: z.string().default(""),
  apns_team_id: z.string().default(""),
  apns_key: z.string().default(""),
  apns_bundle_id: z.string().default("de.hausgeist.koeven"),
  daily_brief: z
    .string()
    .regex(/^(([01]\d|2[0-3]):[0-5]\d)?$/, "daily_brief im Format HH:MM")
    .default("07:30"),
  mail_triage: z.boolean().default(true),
  /** Uhrzeiten für den Mail-Überblick (Berliner Zeit) */
  mail_check_times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).default(["07:00", "12:00", "15:00", "19:00"]),
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
  payment_mode: z.enum(["dryrun", "fints"]),
  fints_product_id: z.string(),
  bank_logins: BankLogins,
  mailboxes: z.array(Mailbox),
  icloud_user: z.string(),
  icloud_app_password: z.string(),
  calendars: z.array(Calendar),
  calendar_feeds: z.array(CalendarFeed),
  ha_calendars: z.array(HaCalendar),
  ha_entities: z.array(z.string()),
  bring_lists: z.array(BringList),
  bring: BringAccount,
  fritzbox: FritzBoxCfg,
  pc: PcCfg,
  energy: Energy,
  daily_brief: time,
  evening_check: time,
  mail_triage: z.boolean(),
  mail_check_times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)),
  weekly_offers: z.boolean(),
  calendar_insights: z.boolean(),
  departure_alerts: z.boolean(),
  departure_buffer_min: z.number().int().min(0).max(60),
  travel_mode: z.enum(["car", "bike", "foot"]),
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

/**
 * Supervisor-Token: steht in der Umgebung – bei s6-overlay-Images aber teils nur
 * in /run/s6/container_environment, wenn der Prozess nicht mit with-contenv startet.
 */
export function readSupervisorToken(): string | undefined {
  const fromEnv = process.env.SUPERVISOR_TOKEN || process.env.HASSIO_TOKEN;
  if (fromEnv) return fromEnv.trim();
  for (const f of ["/run/s6/container_environment/SUPERVISOR_TOKEN", "/var/run/s6/container_environment/SUPERVISOR_TOKEN"]) {
    try {
      const t = readFileSync(f, "utf8").trim();
      if (t) return t;
    } catch { /* nicht vorhanden */ }
  }
  return undefined;
}

/** Liest /data/options.json (Home-Assistant-Add-on) oder für lokale Tests HAUSGEIST_OPTIONS. */
export function loadConfig(): Config {
  const path = process.env.HAUSGEIST_OPTIONS ?? "/data/options.json";
  if (!existsSync(path)) throw new Error(`Konfiguration nicht gefunden: ${path}`);
  const options = Options.parse(JSON.parse(readFileSync(path, "utf8")));
  const supervisorToken = readSupervisorToken();
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
