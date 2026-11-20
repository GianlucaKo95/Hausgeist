import type { Config } from "./config.js";
import { db, listUsers } from "./db.js";
import { formatEuro } from "./checks.js";
import type { HomeAssistant } from "../adapters/homeassistant.js";
import { logger } from "./log.js";

const log = logger("scheduler");

function berlinNow(): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date());
  const [date, time] = parts.split(" ");
  return { date, time };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Tägliches Briefing ohne Sprachmodell: Fristen, fällige Aufgaben, offene
 * Freigaben. Kündigungsfristen werden 30, 14, 7 und 1 Tag vorher gemeldet.
 */
export function startScheduler(config: Config, ha: HomeAssistant): void {
  if (!config.daily_brief) {
    log.info("Tägliches Briefing deaktiviert");
    return;
  }
  let lastRun = "";
  setInterval(() => {
    const { date, time } = berlinNow();
    if (time !== config.daily_brief || lastRun === date) return;
    lastRun = date;
    brief(date, ha).catch((e) => log.error("Briefing fehlgeschlagen", e));
  }, 30_000);
  log.info(`Tägliches Briefing um ${config.daily_brief}`);
}

async function brief(today: string, ha: HomeAssistant): Promise<void> {
  const remindDays = [30, 14, 7, 1, 0];
  const [{ data: deadlines }, { data: chores }, { data: approvals }, { data: actions }, users] = await Promise.all([
    db().from("deadlines").select("title, due_date").eq("done", false).lte("due_date", addDays(today, 30)).order("due_date"),
    db().from("chores").select("title, next_due, assignee_id").lte("next_due", today),
    db().from("approvals").select("amount_cents, invoices(issuer)").eq("status", "pending"),
    db().from("actions").select("summary").eq("status", "pending"),
    listUsers(),
  ]);

  const due = (deadlines ?? []).filter((d) => {
    const days = Math.round((Date.parse(d.due_date) - Date.parse(today)) / 86_400_000);
    return remindDays.includes(days) || days < 0;
  });

  for (const u of users) {
    if (!u.notify_service) continue;
    const lines: string[] = [];
    if (u.role !== "child") {
      for (const d of due) {
        const days = Math.round((Date.parse(d.due_date) - Date.parse(today)) / 86_400_000);
        lines.push(days < 0 ? `❗ Überfällig: ${d.title}` : days === 0 ? `⏰ Heute: ${d.title}` : `📅 In ${days} Tagen: ${d.title}`);
      }
      const pays = approvals ?? [];
      if (pays.length) lines.push(`💶 ${pays.length} Rechnung(en) warten auf Freigabe (${formatEuro(pays.reduce((s, a) => s + a.amount_cents, 0))})`);
      if ((actions ?? []).length) lines.push(`✋ ${(actions ?? []).length} weitere Freigabe(n) offen`);
    }
    for (const c of (chores ?? []).filter((c) => !c.assignee_id || c.assignee_id === u.id)) lines.push(`🧹 Fällig: ${c.title}`);
    if (lines.length) await ha.notify(u.notify_service, "Hausgeist – heute", lines.join("\n"));
  }
  log.info("Briefing verschickt");
}
