import type { Config } from "./config.js";
import { db, listUsers, audit } from "./db.js";
import { formatEuro, entityAllowed, isSensitiveHaService, approversFor, canApproveAction, type AppUser, type ActionKind } from "./checks.js";
import type { HomeAssistant } from "../adapters/homeassistant.js";
import type { ToolContext } from "../tools/context.js";
import { mailTools } from "../tools/mail.js";
import { runMiniAgent, parseJsonObject } from "./mini-agent.js";
import { planCalendarReminders } from "./calendar-insights.js";
import Anthropic from "@anthropic-ai/sdk";
import { ACTION_APPROVE, ACTION_REJECT } from "../agents/finance.js";
import { ACTION_OK, ACTION_NO } from "./actions.js";
import { logger } from "./log.js";

const log = logger("routinen");

export function berlinNow(d = new Date()): { date: string; time: string; weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(d);
  const [date, time] = parts.split(" ");
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sonntag
  return { date, time, weekday, hour: Number(time.slice(0, 2)) };
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Nächster Termin einer Wiederholung. */
export function nextRun(from: Date, repeat: string): Date | null {
  const d = new Date(from);
  switch (repeat) {
    case "daily": d.setDate(d.getDate() + 1); return d;
    case "weekly": d.setDate(d.getDate() + 7); return d;
    case "monthly": d.setMonth(d.getMonth() + 1); return d;
    case "yearly": d.setFullYear(d.getFullYear() + 1); return d;
    case "weekdays": {
      do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6);
      return d;
    }
    default: return null;
  }
}

export type AlertCondition = "below" | "above" | "equals" | "unavailable";

/** Ist die Bedingung eines Alarms erfüllt? */
export function alertMet(condition: AlertCondition, value: string | null, state: string | undefined): boolean {
  if (condition === "unavailable") return state === undefined || state === "unavailable";
  if (state === undefined || state === "unavailable" || state === "unknown") return false;
  if (condition === "equals") return state.toLowerCase() === String(value ?? "").toLowerCase();
  const n = Number(state), t = Number(value);
  if (Number.isNaN(n) || Number.isNaN(t)) return false;
  return condition === "below" ? n < t : n > t;
}

/**
 * Proaktive Routinen: Erinnerungen, geplante Schaltungen, Gerätealarme,
 * Tagesbriefing, wiederkehrende Einkäufe, Mail-Überblick, Preisalarme,
 * Wochenangebote und Nachfassen bei liegengebliebenen Freigaben.
 */
export class Routines {
  private running = new Set<string>();
  private lastDaily: Record<string, string> = {};
  private lastHour = -1;
  private lastAlertCheck = 0;
  private readonly llm: Anthropic;

  constructor(
    private readonly config: Config,
    private readonly ha: HomeAssistant,
    private readonly base: Omit<ToolContext, "user">,
  ) {
    this.llm = new Anthropic({ apiKey: config.anthropic_api_key });
  }

  start(): void {
    setInterval(() => void this.tick(), 30_000);
    log.info(`Routinen aktiv (Briefing ${this.config.daily_brief || "aus"}, Kalender-Vorausdenken ${this.config.calendar_insights ? `morgens + ${this.config.evening_check}` : "aus"}, Mail-Überblick ${this.config.mail_triage ? "an" : "aus"}, Wochenangebote ${this.config.weekly_offers ? "an" : "aus"})`);
  }

  /** Führt eine Routine höchstens einmal gleichzeitig aus und protokolliert Fehler. */
  private run(name: string, fn: () => Promise<void>): void {
    if (this.running.has(name)) return;
    this.running.add(name);
    fn().catch((e) => log.error(`${name} fehlgeschlagen`, e)).finally(() => this.running.delete(name));
  }

  private once(key: string, date: string): boolean {
    if (this.lastDaily[key] === date) return false;
    this.lastDaily[key] = date;
    return true;
  }

  private async tick(): Promise<void> {
    const now = berlinNow();
    this.run("erinnerungen", () => this.reminders());
    this.run("schaltungen", () => this.scheduledActions());
    if (Date.now() - this.lastAlertCheck >= 60_000) {
      this.lastAlertCheck = Date.now();
      this.run("alarme", () => this.alerts());
    }
    if (this.config.daily_brief && now.time >= this.config.daily_brief && this.once("brief", now.date)) {
      this.run("briefing", () => this.brief(now.date));
      this.run("wiederkehrend", () => this.recurringItems(now.date));
      if (this.config.mail_triage) this.run("mail", () => this.mailTriage());
      if (this.config.weekly_offers && now.weekday === 1) this.run("angebote", () => this.weeklyOffers());
      if (this.config.calendar_insights) this.run("kalender", () => this.calendarInsights());
    }
    if (this.config.calendar_insights && this.config.evening_check && now.time >= this.config.evening_check && this.once("abend", now.date)) {
      this.run("kalender", () => this.calendarInsights());
    }
    if (now.time >= "06:30" && this.once("preise", now.date)) this.run("preise", () => this.priceWatches());
    if (now.hour !== this.lastHour) {
      this.lastHour = now.hour;
      if (now.hour >= 8 && now.hour <= 20) this.run("freigaben", () => this.staleApprovals());
    }
  }

  private async notifyUsers(users: AppUser[], title: string, message: string): Promise<void> {
    for (const u of users) if (u.notify_service) await this.ha.notify(u.notify_service, title, message);
  }

  private async adults(): Promise<AppUser[]> {
    return (await listUsers()).filter((u) => u.role !== "child" && u.notify_service);
  }

  // ── Erinnerungen ─────────────────────────────────────────────────────────
  private async reminders(): Promise<void> {
    const { data } = await db().from("reminders").select("id, user_id, message, due_at, repeat").eq("done", false).lte("due_at", new Date().toISOString()).limit(50);
    if (!data?.length) return;
    const users = await listUsers();
    for (const r of data) {
      const u = users.find((x) => x.id === r.user_id);
      if (u?.notify_service) await this.ha.notify(u.notify_service, "Erinnerung", r.message);
      const next = nextRun(new Date(r.due_at), r.repeat);
      // Bei verpassten Wiederholungen (z. B. nach Ausfall) bis in die Zukunft vorspulen.
      while (next && next.getTime() <= Date.now()) next.setTime(nextRun(next, r.repeat)!.getTime());
      await db().from("reminders").update(next ? { due_at: next.toISOString() } : { done: true }).eq("id", r.id);
    }
  }

  // ── Geplante Schaltungen ─────────────────────────────────────────────────
  private async scheduledActions(): Promise<void> {
    const { data } = await db().from("scheduled_actions").select("*").eq("active", true).lte("run_at", new Date().toISOString()).limit(20);
    for (const a of data ?? []) {
      let result: string;
      if (!entityAllowed(a.entity_id, this.config.ha_entities) || isSensitiveHaService(a.domain) || isSensitiveHaService(a.entity_id.split(".")[0])) {
        result = "nicht erlaubt (Whitelist oder sicherheitsrelevant)";
      } else {
        try {
          await this.ha.callService(a.domain, a.service, { entity_id: a.entity_id, ...(a.data ?? {}) });
          result = "ok";
        } catch (e) {
          result = `Fehler: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      let next = nextRun(new Date(a.run_at), a.repeat);
      while (next && next.getTime() <= Date.now()) next = nextRun(next, a.repeat);
      await db().from("scheduled_actions").update({
        last_run: new Date().toISOString(), last_result: result,
        ...(next ? { run_at: next.toISOString() } : { active: false }),
      }).eq("id", a.id);
      await audit({ agent: "household", action: "scheduled_action", level: 1, result, ref_table: "scheduled_actions", ref_id: a.id });
      if (result !== "ok") {
        const creator = (await listUsers()).find((u) => u.id === a.created_by);
        if (creator) await this.notifyUsers([creator], "Geplante Schaltung fehlgeschlagen", `${a.label ?? `${a.domain}.${a.service} ${a.entity_id}`}: ${result}`);
      }
    }
  }

  // ── Gerätealarme ─────────────────────────────────────────────────────────
  private async alerts(): Promise<void> {
    const { data } = await db().from("alerts").select("*").eq("active", true);
    if (!data?.length) return;
    const states = new Map((await this.ha.states()).map((s) => [s.entity_id, s.state]));
    const users = await listUsers();
    for (const a of data) {
      const met = alertMet(a.condition, a.value, states.get(a.entity_id));
      if (!met) {
        if (a.since || a.triggered) await db().from("alerts").update({ since: null, triggered: false }).eq("id", a.id);
        continue;
      }
      if (a.triggered) continue;
      const since = a.since ? new Date(a.since) : new Date();
      if (!a.since) await db().from("alerts").update({ since: since.toISOString() }).eq("id", a.id);
      if (Date.now() - since.getTime() < a.for_minutes * 60_000) continue;

      const targets = (a.notify as string[]).length
        ? users.filter((u) => (a.notify as string[]).some((n) => n.toLowerCase() === u.name.toLowerCase()))
        : users.filter((u) => u.role !== "child");
      let extra = "";
      if (a.action) {
        const act = a.action as { domain: string; service: string; entity_id: string; data?: Record<string, unknown> };
        if (entityAllowed(act.entity_id, this.config.ha_entities) && !isSensitiveHaService(act.domain) && !isSensitiveHaService(act.entity_id.split(".")[0])) {
          try {
            await this.ha.callService(act.domain, act.service, { entity_id: act.entity_id, ...(act.data ?? {}) });
            extra = `\n→ ${act.entity_id} geschaltet`;
          } catch (e) {
            extra = `\n→ Schalten fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
      }
      await this.notifyUsers(targets, "Hausgeist", `${a.message}${extra}`);
      await db().from("alerts").update({ triggered: true, last_fired: new Date().toISOString() }).eq("id", a.id);
      await audit({ agent: "household", action: "alert", level: a.action ? 1 : 0, result: "fired", ref_table: "alerts", ref_id: a.id });
    }
  }

  // ── Kalender vorausdenken ────────────────────────────────────────────────
  private async calendarInsights(): Promise<void> {
    await planCalendarReminders(this.config, this.base.calendar, this.llm);
  }

  // ── Tagesbriefing ────────────────────────────────────────────────────────
  private async brief(today: string): Promise<void> {
    const remindDays = [30, 14, 7, 1, 0];
    const [{ data: deadlines }, { data: chores }, { data: approvals }, { data: actions }, users] = await Promise.all([
      db().from("deadlines").select("title, due_date").eq("done", false).lte("due_date", addDays(today, 30)).order("due_date"),
      db().from("chores").select("title, next_due, assignee_id").lte("next_due", today),
      db().from("approvals").select("amount_cents").eq("status", "pending"),
      db().from("actions").select("summary").eq("status", "pending"),
      listUsers(),
    ]);
    // Heutige Termine aus allen Kalendern
    let todays: { title: string; start: string; allDay: boolean; calendar: string }[] = [];
    try {
      if (this.base.calendar.enabled) {
        const from = new Date(`${today}T00:00:00`);
        const to = new Date(from.getTime() + 86_400_000);
        todays = await this.base.calendar.events(from.toISOString(), to.toISOString());
      }
    } catch (e) {
      log.warn("Kalender für das Briefing nicht lesbar", e);
    }
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
        if (pays.length) lines.push(`💶 ${pays.length} Zahlung(en) warten auf Freigabe (${formatEuro(pays.reduce((s, a) => s + a.amount_cents, 0))})`);
        if ((actions ?? []).length) lines.push(`✋ ${(actions ?? []).length} weitere Freigabe(n) offen`);
      }
      for (const ev of todays) {
        const owner = this.base.calendar.ownerOf(ev.calendar);
        if (owner && owner !== "shared" && owner.toLowerCase() !== u.name.toLowerCase()) continue;
        const time = ev.allDay ? "ganztägig" : new Date(ev.start).toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" });
        lines.push(`🗓️ ${time}: ${ev.title}`);
      }
      for (const c of (chores ?? []).filter((c) => !c.assignee_id || c.assignee_id === u.id)) lines.push(`🧹 Fällig: ${c.title}`);
      if (lines.length) await this.ha.notify(u.notify_service, "Hausgeist – heute", lines.join("\n"));
    }
  }

  // ── Wiederkehrende Einkäufe ──────────────────────────────────────────────
  private async recurringItems(today: string): Promise<void> {
    const { data } = await db().from("recurring_items").select("*").eq("active", true).lte("next_due", today);
    for (const r of data ?? []) {
      try {
        if (!(await this.base.shopping.isOpen(r.item, r.store))) {
          await this.base.shopping.add([{ item: r.item, quantity: r.quantity ?? undefined, store: r.store ?? undefined }]);
        }
      } catch (e) {
        log.error(`Wiederkehrender Artikel ${r.item} nicht eingetragen`, e);
        continue; // nächster Versuch beim nächsten Durchlauf
      }
      let next = r.next_due as string;
      while (next <= today) next = addDays(next, r.interval_days);
      await db().from("recurring_items").update({ next_due: next }).eq("id", r.id);
    }
    if (data?.length) log.info(`${data.length} wiederkehrende Artikel geprüft`);
  }

  // ── Mail-Überblick ───────────────────────────────────────────────────────
  private async mailTriage(): Promise<void> {
    for (const user of await this.adults()) {
      const ctx: ToolContext = { ...this.base, user };
      const tools = mailTools(ctx, "private", "communication").filter((t) => ["list_mailboxes", "list_mails", "read_mail"].includes(t.name));
      const summary = await runMiniAgent(this.config, {
        system: `Du bist der Communication-Agent und erstellst für ${user.name} einen kurzen Mail-Überblick. Du liest nur – nichts senden, verschieben oder markieren.`,
        prompt: `Schau dir die ungelesenen Mails der letzten 24 Stunden in allen Postfächern an, die du für ${user.name} siehst.
Fasse in höchstens 8 kurzen Zeilen zusammen:
- ❗ Wichtig (Behörden, Fristen, Bank, Schule, Arzt …)
- ✉️ Braucht eine Antwort (wer, worum)
- 📅 Enthält einen Termin (Datum, Anlass)
Newsletter und Werbung nur als eine Zeile „x Newsletter/Werbung“. Wenn es nichts Relevantes gibt, antworte genau NICHTS.`,
        tools: tools as never,
      });
      if (summary && !/^NICHTS\b/.test(summary) && user.notify_service) {
        await this.ha.notify(user.notify_service, "Mail-Überblick", summary.slice(0, 1500));
      }
    }
  }

  // ── Preisalarme ──────────────────────────────────────────────────────────
  private async priceWatches(): Promise<void> {
    const { data } = await db().from("price_watches").select("*").eq("active", true);
    for (const w of data ?? []) {
      const text = await runMiniAgent(this.config, {
        system: "Du bist der Shopping-Agent und prüfst aktuelle Preise bei seriösen deutschen Händlern (Preis inkl. Versand, lieferbar).",
        prompt: `Finde den aktuell günstigsten Preis für: ${w.product}${w.url ? `\nBekannte Produktseite: ${w.url}` : ""}
Antworte ausschließlich mit JSON: {"price_euro": Zahl oder null, "shop": "Händler", "url": "Link"}`,
        web: true,
        maxTurns: 10,
      });
      const r = parseJsonObject<{ price_euro: number | null; shop?: string; url?: string }>(text);
      const price = r?.price_euro != null ? Math.round(r.price_euro * 100) : null;
      await db().from("price_watches").update({
        last_checked: new Date().toISOString(), last_price_cents: price, last_shop: r?.shop ?? null, last_url: r?.url ?? null,
      }).eq("id", w.id);
      const recently = w.notified_at && Date.now() - Date.parse(w.notified_at) < 7 * 86_400_000;
      if (price != null && price <= w.target_cents && !recently) {
        const users = await listUsers();
        const target = users.filter((u) => u.id === w.created_by);
        await this.notifyUsers(target.length ? target : users.filter((u) => u.role === "admin"), "Preisalarm",
          `${w.product}: ${formatEuro(price)} bei ${r?.shop ?? "?"} (Ziel ${formatEuro(w.target_cents)})${r?.url ? `\n${r.url}` : ""}`);
        await db().from("price_watches").update({ notified_at: new Date().toISOString() }).eq("id", w.id);
      }
    }
  }

  // ── Wochenangebote ───────────────────────────────────────────────────────
  private async weeklyOffers(): Promise<void> {
    const [list, { data: rec }, { data: prefs }] = await Promise.all([
      this.base.shopping.list().catch(() => []),
      db().from("recurring_items").select("item").eq("active", true),
      db().from("preferences").select("key, value").is("user_id", null).ilike("key", "einkauf%"),
    ]);
    const items = [...new Set([...(list ?? []), ...(rec ?? [])].map((i) => String(i.item)))].slice(0, 25);
    if (items.length === 0) return;
    const stores = (prefs ?? []).map((p) => `${p.key}: ${JSON.stringify(p.value)}`).join("; ") || "Rewe, Edeka, Aldi, Lidl, dm, Rossmann";
    const text = await runMiniAgent(this.config, {
      system: "Du bist der Shopping-Agent und suchst Prospekt-Angebote dieser Woche bei Läden in Duisburg.",
      prompt: `Bevorzugte Läden/Präferenzen: ${stores}
Artikel: ${items.join(", ")}
Finde Angebote dieser Woche für diese Artikel. Höchstens 8 Zeilen im Format „Artikel – Laden – Preis (gültig bis)“.
Nur echte, belegbare Angebote. Wenn nichts Passendes: antworte genau NICHTS.`,
      web: true,
      maxTurns: 20,
    });
    if (text && !/^NICHTS\b/.test(text)) await this.notifyUsers(await this.adults(), "Angebote diese Woche", text.slice(0, 1500));
  }

  // ── Liegengebliebene Freigaben ───────────────────────────────────────────
  private async staleApprovals(): Promise<void> {
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const users = await listUsers();

    // Nach 7 Tagen verfallen offene Anfragen.
    const { data: oldPays } = await db().from("approvals").select("id, invoice_id").eq("status", "pending").lt("created_at", weekAgo);
    for (const p of oldPays ?? []) {
      await db().from("approvals").update({ status: "expired" }).eq("id", p.id).eq("status", "pending");
      await db().from("invoices").update({ status: "needs_review", review_note: "Freigabe nach 7 Tagen verfallen" }).eq("id", p.invoice_id);
      await audit({ agent: "finance", action: "approval_expired", level: 2, result: "expired", ref_table: "approvals", ref_id: p.id });
    }
    const { data: oldActs } = await db().from("actions").select("id").eq("status", "pending").lt("created_at", weekAgo);
    for (const a of oldActs ?? []) await db().from("actions").update({ status: "expired" }).eq("id", a.id).eq("status", "pending");
    if ((oldPays?.length ?? 0) + (oldActs?.length ?? 0) > 0) {
      await this.notifyUsers(users.filter((u) => u.role === "admin"), "Hausgeist", `${(oldPays?.length ?? 0) + (oldActs?.length ?? 0)} Freigabe(n) nach 7 Tagen verfallen – nichts wurde ausgeführt.`);
    }

    // Nach 24 Stunden einmal täglich nachfassen.
    const { data: pays } = await db().from("approvals")
      .select("id, amount_cents, payee_status, created_at, reminded_at, invoices(issuer)")
      .eq("status", "pending").lt("created_at", dayAgo).or(`reminded_at.is.null,reminded_at.lt.${dayAgo}`);
    for (const p of pays ?? []) {
      const issuer = (p.invoices as unknown as { issuer: string } | null)?.issuer ?? "?";
      const days = Math.floor((Date.now() - Date.parse(p.created_at)) / 86_400_000);
      for (const u of approversFor(users, { amount_cents: p.amount_cents, payee_status: p.payee_status })) {
        await this.ha.notify(u.notify_service!, "Wartet auf dich", `Zahlung ${formatEuro(p.amount_cents)} an ${issuer} wartet seit ${days} Tag(en).`, [
          { action: `${ACTION_APPROVE}${p.id}`, title: "Freigeben" },
          { action: `${ACTION_REJECT}${p.id}`, title: "Ablehnen", destructive: true },
        ], `hg-${p.id}`);
      }
      await db().from("approvals").update({ reminded_at: new Date().toISOString() }).eq("id", p.id);
    }
    const { data: acts } = await db().from("actions")
      .select("id, kind, summary, amount_cents, created_at, payload").eq("status", "pending").lt("created_at", dayAgo)
      .or(`reminded_at.is.null,reminded_at.lt.${dayAgo}`);
    for (const a of acts ?? []) {
      const ownerRes = a.kind === "send_mail"
        ? await db().from("mailboxes").select("owner_id").eq("name", (a.payload as { mailbox?: string }).mailbox ?? "").maybeSingle()
        : { data: null };
      const approvers = users.filter((u) => u.notify_service && canApproveAction(u, { kind: a.kind as ActionKind, amount_cents: a.amount_cents, mailbox_owner_id: ownerRes.data?.owner_id ?? null }).allowed);
      for (const u of approvers) {
        await this.ha.notify(u.notify_service!, "Wartet auf dich", a.summary, [
          { action: `${ACTION_OK}${a.id}`, title: "Freigeben" },
          { action: `${ACTION_NO}${a.id}`, title: "Ablehnen", destructive: true },
        ], `hg-act-${a.id}`);
      }
      await db().from("actions").update({ reminded_at: new Date().toISOString() }).eq("id", a.id);
    }
  }
}
