import { loadConfig } from "./core/config.js";
import { db } from "./core/db.js";
import { logger, setLogLevel } from "./core/log.js";
import { ActionService } from "./core/actions.js";
import { startServer } from "./core/server.js";
import { Routines } from "./core/scheduler.js";
import { initUploads } from "./core/uploads.js";
import { HomeAssistant } from "./adapters/homeassistant.js";
import { AppleCalendar, CalendarHub } from "./adapters/calendar.js";
import { Paperless } from "./adapters/paperless.js";
import { DryRunProvider, FinTSProvider } from "./adapters/payment.js";
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

  const { error } = await db().from("users").select("id", { head: true, count: "exact" });
  if (error) throw new Error(`Supabase nicht erreichbar oder Schema fehlt: ${error.message}`);

  const ha = new HomeAssistant(config);
  const apple = new AppleCalendar(config);
  const paperless = new Paperless(config);
  const actions = new ActionService(config, ha, apple);
  const calendar = new CalendarHub(config, apple, ha);

  // Posteingang: Mails und Uploads → Rechnung, Vertrag, Termin oder Ablage
  const documents = new DocumentAgent(config);
  const payments = config.payment_mode === "fints" ? new FinTSProvider() : new DryRunProvider();
  const executor = new Executor(payments, ha, documents);
  const finance = new FinanceAgent(ha, executor);
  const intake = new IntakeAgent(config, ha, documents, finance, actions);
  const communication = new CommunicationAgent(config, (mail) => intake.handleMail(mail));

  // Master-Agent mit acht Fachagenten (auf Anfrage) und Routinen (zeitgesteuert)
  const base = { config, ha, calendar, paperless, actions, finance, intake };
  const master = new MasterAgent(config, base);
  const routines = new Routines(config, ha, base);

  ha.onNotificationAction((action, haUserId) => {
    (async () => {
      if (await actions.handleDecision(action, haUserId)) return;
      await finance.handleAction(action, haUserId);
    })().catch((e) => log.error("Freigabe-Verarbeitung fehlgeschlagen", e));
  });

  communication.start();
  startServer(config, master, finance, actions, ha);
  routines.start();

  log.info(`Hausgeist läuft (Zahlungsmodus: ${payments.name})`);
}

main().catch((e) => {
  log.error("Start fehlgeschlagen", e);
  process.exit(1);
});
