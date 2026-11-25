import { createServer, type Server } from "node:http";
import { DbWatch } from "./core/db-watch.js";
import { AlpacaPaper } from "./adapters/alpaca.js";
import { IntradayEngine } from "./core/intraday.js";
import { FritzBox } from "./adapters/fritzbox.js";
import { WindowsPc } from "./adapters/pc.js";
import { Positions } from "./core/location.js";
import { BringClient } from "./adapters/bring.js";
import { TvHub } from "./core/tv-hub.js";
import { detectFromHa } from "./core/energy-detect.js";
import { ShoppingList } from "./core/shopping-list.js";
import { loadConfig } from "./core/config.js";
import { db, enableAppPush } from "./core/db.js";
import { ApnsClient } from "./adapters/apns.js";
import { logger, setLogLevel } from "./core/log.js";
import { ActionService } from "./core/actions.js";
import { startServer } from "./core/server.js";
import { Routines } from "./core/scheduler.js";
import { initUploads } from "./core/uploads.js";
import { SettingsStore } from "./core/settings.js";
import { HomeAssistant } from "./adapters/homeassistant.js";
import { AppleCalendar, CalendarHub } from "./adapters/calendar.js";
import { Paperless } from "./adapters/paperless.js";
import { DryRunProvider, FinTSProvider, SwitchingProvider } from "./adapters/payment.js";
import { CommunicationAgent } from "./agents/communication.js";
import { DocumentAgent } from "./agents/document.js";
import { Executor } from "./agents/executor.js";
import { FinanceAgent } from "./agents/finance.js";
import { IntakeAgent } from "./agents/intake.js";
import { MasterAgent } from "./agents/master.js";

const log = logger("hausgeist");

async function main() {
  const config = loadConfig();
  setLogLevel(config.log_level);
  db(config);
  initUploads(config.dataDir);

  const ha = new HomeAssistant(config);
  fetch(`${config.haBaseUrl}/`, { headers: { Authorization: `Bearer ${config.supervisorToken}` } })
    .then((r) => r.ok ? log.info("Home Assistant erreichbar") : log.error(`Home Assistant lehnt ab: HTTP ${r.status}`))
    .catch((e) => log.error("Home Assistant nicht erreichbar", e));
  const apns = new ApnsClient(config);
  if (apns.enabled) {
    enableAppPush(true);
    ha.setAppSender((userId, title, message, acts, tag) => apns.notifyUser(userId, title, message, acts, tag));
    log.info("Push über die Hausgeist-App aktiv");
  }
  const dbWatch = new DbWatch(config, (svc, t, m) => ha.notify(svc, t, m));

  // Während des Wartens auf Supabase schon auf Port 8099 antworten: der Watchdog sieht „lebt“,
  // die App bekommt eine klare Meldung statt einer Zeitüberschreitung.
  let waiting: Server | null = null;
  // Supabase kann hängen – geduldig warten, statt aufzugeben.
  for (let attempt = 1; ; attempt++) {
    const { error, status } = await db().from("users").select("id").limit(1);
    if (!error) break;
    waiting ??= createServer((req, res) => {
      const health = (req.url ?? "").endsWith("/api/health");
      res.writeHead(health ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health ? { ok: true, version: process.env.HAUSGEIST_VERSION ?? "dev", starting: true } : { error: "Hausgeist wartet auf die Datenbank (Supabase antwortet nicht)." }));
    }).listen(8099);
    const reason = error.message || `HTTP ${status}`;
    const hint = status === 504 || status === 503
      ? "Supabase-Schnittstelle antwortet nicht (im Supabase-Dashboard Projekt neu starten)"
      : status === 401 ? "Supabase-Schlüssel falsch (supabase_service_key)"
      : status === 404 ? "Tabelle fehlt – Migrationen ausführen" : "unbekannt";
    // Nicht aufgeben (sonst Neustart-Schleife ohne Warnung) – die Wache meldet die Störung per Push
    if (status === 401 || status === 404) throw new Error(`Supabase: ${reason} – ${hint}`);
    log.warn(`Supabase noch nicht bereit (${reason} – ${hint}), Versuch ${attempt} – nächster in 30 s`);
    await dbWatch.check().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30_000));
  }

  if (waiting) { waiting.closeAllConnections(); await new Promise((r) => waiting!.close(r)); }

  if (!config.supervisorToken) log.error("Kein Supervisor-Token gefunden – Home Assistant ist nicht erreichbar (homeassistant_api in config.yaml prüfen)");
  const apple = new AppleCalendar(config);
  const paperless = new Paperless(config);
  const fritz = new FritzBox(config);
  const pc = new WindowsPc(config);
  pc.keyPair(); // Schlüssel beim ersten Start erzeugen, damit die App ihn anzeigen kann
  const actions = new ActionService(config, ha, apple, pc, fritz);
  const calendar = new CalendarHub(config, apple, ha);

  // Posteingang: Mails und Uploads → Rechnung, Vertrag, Termin oder Ablage
  const documents = new DocumentAgent(config);
  const fints = new FinTSProvider(config);
  const payments = new SwitchingProvider(config, new DryRunProvider(), fints);
  const executor = new Executor(payments, ha, documents);
  const finance = new FinanceAgent(ha, executor);
  const intake = new IntakeAgent(config, ha, documents, finance, actions);
  const communication = new CommunicationAgent(config, (mail) => intake.handleMail(mail));

  // Master-Agent mit acht Fachagenten (auf Anfrage) und Routinen (zeitgesteuert)
  const bring = new BringClient(config);
  const shopping = new ShoppingList(config, ha, bring);
  const positions = new Positions(config.dataDir);
  const alpaca = new AlpacaPaper(() => config.alpaca);
  const intraday = new IntradayEngine(alpaca);
  const tv = new TvHub(config.dataDir);
  let settingsRef: SettingsStore | undefined;
  const saveSettings = async (patch: Record<string, unknown>) => { await settingsRef?.update(patch); };
  const base = { config, ha, calendar, paperless, actions, finance, intake, shopping, fritz, pc, positions, tv, alpaca, intraday, saveSettings };
  const master = new MasterAgent(config, base);
  const routines = new Routines(config, ha, base, fints);
  routines.intraday = intraday;
  routines.dbWatch = dbWatch;
  routines.alpaca = alpaca;

  ha.onNotificationAction((action, haUserId) => {
    (async () => {
      if (await actions.handleDecision(action, haUserId)) return;
      await finance.handleAction(action, haUserId);
    })().catch((e) => log.error("Freigabe-Verarbeitung fehlgeschlagen", e));
  });

  communication.start();
  const settings = new SettingsStore(config);
  settingsRef = settings;
  // Energie-Sensoren noch nicht gewählt? Selbst suchen (Energie-Dashboard, Gerätenamen).
  if (!Object.values(config.energy).some(Boolean)) {
    detectFromHa(ha).then(async (r) => {
      if (!Object.keys(r.pick).length) return;
      await settings.update({ energy: r.pick });
      log.info(`Energie-Sensoren automatisch gewählt: ${Object.entries(r.pick).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }).catch((e) => log.warn("Energie-Sensoren nicht erkannt", e));
  }
  settings.onChange(async (changed) => {
    if (changed.includes("mailboxes")) await communication.restart();
    if (changed.includes("icloud_user") || changed.includes("icloud_app_password")) apple.reset();
    if (changed.includes("fritzbox")) fritz.reset();
    if (changed.includes("bring")) bring.reset();
  });
  startServer(config, master, finance, actions, ha, settings, fints, { fritz, pc, positions, bring, tv });
  routines.start();

  log.info(`Hausgeist läuft (Zahlungsmodus: ${payments.name})`);
}

// Ein einzelner Fehler (z. B. eine kurz nicht erreichbare Schnittstelle) darf den Dienst nicht beenden.
process.on("unhandledRejection", (e) => log.error("Unbehandelter Fehler (Dienst läuft weiter)", e));
process.on("uncaughtException", (e) => {
  // Abgebrochene Netzwerkverbindungen (Mailserver, Home Assistant …) sind kein Grund für einen Neustart
  const msg = `${(e as NodeJS.ErrnoException).code ?? ""} ${e.message}`;
  if (/Socket timeout|ETIMEDOUT|ECONNRESET|EPIPE|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|Connection not available|NoConnection/i.test(msg)) {
    log.warn("Netzwerkverbindung abgebrochen (Dienst läuft weiter)", e);
    return;
  }
  log.error("Schwerer Fehler – Neustart durch den Watchdog", e);
  setTimeout(() => process.exit(1), 500);
});

main().catch((e) => {
  log.error("Start fehlgeschlagen", e);
  process.exit(1);
});
