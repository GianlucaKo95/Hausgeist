import { loadConfig } from "./core/config.js";
import { db } from "./core/db.js";
import { logger, setLogLevel } from "./core/log.js";
import { HomeAssistant } from "./adapters/homeassistant.js";
import { DryRunProvider, FinTSProvider } from "./adapters/payment.js";
import { CommunicationAgent } from "./agents/communication.js";
import { DocumentAgent } from "./agents/document.js";
import { Executor } from "./agents/executor.js";
import { FinanceAgent } from "./agents/finance.js";

const log = logger("hausgeist");

async function main() {
  const config = loadConfig();
  setLogLevel(config.log_level);
  db(config);

  const { error } = await db().from("users").select("id", { head: true, count: "exact" });
  if (error) throw new Error(`Supabase nicht erreichbar oder Schema fehlt: ${error.message}`);

  const ha = new HomeAssistant(config);
  const documents = new DocumentAgent(config);
  const payments = config.payment_mode === "fints" ? new FinTSProvider() : new DryRunProvider();
  const executor = new Executor(payments, ha, documents);
  const finance = new FinanceAgent(config, ha, documents, executor);
  const communication = new CommunicationAgent(config, (mail) => finance.handleMail(mail));

  ha.onNotificationAction((action, haUserId) => {
    finance.handleAction(action, haUserId).catch((e) => log.error("Freigabe-Verarbeitung fehlgeschlagen", e));
  });
  communication.start();

  log.info(`Hausgeist läuft (Zahlungsmodus: ${payments.name})`);
}

main().catch((e) => {
  log.error("Start fehlgeschlagen", e);
  process.exit(1);
});
