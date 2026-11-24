import { FritzBox } from "./adapters/fritzbox.js";
import { WindowsPc } from "./adapters/pc.js";
import { Positions } from "./core/location.js";
import { BringClient } from "./adapters/bring.js";
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

  // Supabase kann kurz hängen – bis zu 5 Minuten geduldig sein, statt sofort aufzugeben.
  for (let attempt = 1; ; attempt++) {
    const { error, status } = await db().from("users").select("id").limit(1);
    if (!error) break;
    const reason = error.message || `HTTP ${status}`;
    const hint = status === 504 || status === 503
      ? "Supabase-Schnittstelle antwortet nicht (im Supabase-Dashboard Projekt neu starten)"
      : status === 401 ? "Supabase-Schlüssel falsch (supabase_service_key)"
      : status === 404 ? "Tabelle fehlt – Migrationen ausführen" : "unbekannt";
    if (attempt >= 10) throw new Error(`Supabase nicht erreichbar: ${reason} – ${hint}`);
    log.warn(`Supabase noch nicht bereit (${reason} – ${hint}), Versuch ${attempt}/10 in 30 s`);
    await new Promise((r) => setTimeout(r, 30_000));
  }

  if (!config.supervisorToken) log.error("Kein Supervisor-Token gefunden – Home Assistant ist nicht erreichbar (homeassistant_api in config.yaml prüfen)");
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
  let settingsRef: SettingsStore | undefined;
  const saveSettings = async (patch: Record<string, unknown>) => { await settingsRef?.update(patch); };
  const base = { config, ha, calendar, paperless, actions, finance, intake, shopping, fritz, pc, positions, saveSettings };
  const master = new MasterAgent(config, base);
  const routines = new Routines(config, ha, base, fints);

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
  startServer(config, master, finance, actions, ha, settings, fints, { fritz, pc, positions, bring });
  routines.start();

  log.info(`Hausgeist läuft (Zahlungsmodus: ${payments.name})`);
}

// Ein einzelner Fehler (z. B. eine kurz nicht erreichbare Schnittstelle) darf den Dienst nicht beenden.
process.on("unhandledRejection", (e) => log.error("Unbehandelter Fehler (Dienst läuft weiter)", e));
process.on("uncaughtException", (e) => {
  log.error("Schwerer Fehler – Neustart durch den Watchdog", e);
  setTimeout(() => process.exit(1), 500);
});

main().catch((e) => {
  log.error("Start fehlgeschlagen", e);
  process.exit(1);
});
