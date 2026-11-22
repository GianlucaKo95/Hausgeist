import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import type { Config } from "../core/config.js";
import { db, audit, listUsers } from "../core/db.js";
import { formatEuro, noticeDeadline, type AppUser } from "../core/checks.js";
import type { HomeAssistant } from "../adapters/homeassistant.js";
import { parseEvents } from "../adapters/calendar.js";
import type { ActionService } from "../core/actions.js";
import { classifyDocument, isSupportedMime, type DocumentInfo, type FileMime } from "./extract.js";
import type { IncomingMail } from "./communication.js";
import type { DocumentAgent } from "./document.js";
import type { FinanceAgent } from "./finance.js";
import { logger } from "../core/log.js";

const log = logger("intake");

export interface IntakeSource {
  source: string;               // Postfach-Name oder "app"
  messageId?: string | null;
  from?: string;
  subject?: string;
  text?: string;
  note?: string;                // Hinweis der Person beim Hochladen
  filename: string;
  data: Buffer;
  mime: FileMime;
  owner?: AppUser | null;       // für wen das Dokument ist (Besitzer des Postfachs / Hochladende)
}

/**
 * Posteingang: ordnet Dokumente aus Mails und der App ein und gibt sie an den
 * zuständigen Agenten – Rechnung → Finance, Vertrag → Document (Frist anlegen),
 * Termin → Family (Vorschlag zur Übernahme), sonst Ablage.
 */
export class IntakeAgent {
  private readonly llm: Anthropic;

  constructor(
    private readonly config: Config,
    private readonly ha: HomeAssistant,
    private readonly documents: DocumentAgent,
    private readonly finance: FinanceAgent,
    private readonly actions: ActionService,
  ) {
    this.llm = new Anthropic({ apiKey: config.anthropic_api_key });
  }

  private async mailboxOwner(name: string): Promise<AppUser | null> {
    const { data } = await db().from("mailboxes").select("owner_id").eq("name", name).maybeSingle();
    if (!data?.owner_id) return null;
    return (await listUsers()).find((u) => u.id === data.owner_id) ?? null;
  }

  async handleMail(mail: IncomingMail): Promise<void> {
    const owner = await this.mailboxOwner(mail.mailbox);
    for (const pdf of mail.pdfs) {
      try {
        await this.handleFile({
          source: mail.mailbox, messageId: mail.messageId, from: mail.from, subject: mail.subject,
          text: mail.text, filename: pdf.filename, data: pdf.content, mime: "application/pdf", owner,
        });
      } catch (e) {
        log.error(`${pdf.filename} aus ${mail.mailbox} fehlgeschlagen`, e);
        await audit({ agent: "intake", action: "classify", level: 0, result: "error", detail: { file: pdf.filename, error: String(e) } });
      }
    }
    for (const ics of mail.invites) {
      try {
        await this.handleInvite(ics.content.toString("utf8"), owner, mail.from);
      } catch (e) {
        log.error(`Einladung ${ics.filename} fehlgeschlagen`, e);
      }
    }
  }

  /** Einordnen und weiterleiten. Gibt eine Zusammenfassung für den Chat zurück. */
  async handleFile(src: IntakeSource): Promise<string> {
    if (!isSupportedMime(src.mime)) return `Dateityp ${src.mime} wird nicht unterstützt.`;
    const sha = createHash("sha256").update(src.data).digest("hex");
    const { data: seen } = await db().from("invoices").select("id, status").eq("source_sha256", sha).maybeSingle();
    if (seen) return "Dieses Dokument wurde schon verarbeitet.";

    const info = await classifyDocument(this.llm, this.config.model, { data: src.data, mime: src.mime }, src);
    this.documents.keep(sha, src.data, src.mime);
    await audit({ agent: "intake", action: "classify", level: 0, result: info.document_type, detail: { file: src.filename, issuer: info.issuer, source: src.source } });

    switch (info.document_type) {
      case "invoice":
        if (info.needs_payment) {
          const r = await this.finance.createPaymentRequest({
            source: src.source, messageId: src.messageId, sha, issuer: info.issuer, iban: info.iban, bic: info.bic,
            amount_cents: info.amount_cents, currency: info.currency, reference: info.reference,
            invoice_number: info.invoice_number, invoice_date: info.invoice_date, due_date: info.due_date,
            recipient_name: info.recipient_name, category: info.category, suspicious: info.suspicious,
            requestedBy: src.source === "app" ? src.owner ?? null : null,
          });
          return `Rechnung von ${info.issuer} erkannt. ${r.message}`;
        }
        await this.file(sha, src, info, ["Rechnung", "keine Überweisung", info.category ?? ""]);
        return `Rechnung von ${info.issuer} über ${formatEuro(info.amount_cents)} – keine Überweisung nötig (z. B. Lastschrift). Abgelegt.`;

      case "contract":
        return this.handleContract(sha, src, info);

      case "appointment":
        await this.file(sha, src, info, ["Termin"]);
        return this.proposeAppointment(info, src.owner ?? null, info.issuer);

      default:
        await this.file(sha, src, info, ["Posteingang"]);
        return `Abgelegt: ${info.summary}`;
    }
  }

  private async file(sha: string, src: IntakeSource, info: DocumentInfo, tags: string[]): Promise<void> {
    try {
      await this.documents.file(sha, {
        filename: src.filename,
        title: [info.issuer, info.contract_title ?? info.invoice_number].filter(Boolean).join(" ") || src.subject || src.filename,
        tags,
        created: info.invoice_date ?? info.contract_start,
      });
    } catch (e) {
      log.error("Ablage fehlgeschlagen", e);
    }
  }

  private async handleContract(sha: string, src: IntakeSource, info: DocumentInfo): Promise<string> {
    const title = info.contract_title ?? info.summary;
    const { data, error } = await db().from("contracts").insert({
      title, provider: info.issuer, monthly_cents: info.contract_monthly_cents,
      start_date: info.contract_start, end_date: info.contract_end,
      notice_period_days: info.notice_period_days, auto_renew_months: info.auto_renew_months,
      owner_id: src.owner?.id ?? null,
    }).select("id").single();
    if (error) throw error;
    const deadline = noticeDeadline(info.contract_end, info.notice_period_days);
    if (deadline) await db().from("deadlines").insert({ contract_id: data.id, title: `Kündigungsfrist ${info.issuer} – ${title}`, due_date: deadline });
    await this.file(sha, src, info, ["Vertrag"]);
    await audit({ agent: "document", action: "contract_detected", level: 1, result: "saved", ref_table: "contracts", ref_id: data.id });

    const msg = `${info.issuer}: ${title}` +
      (info.contract_monthly_cents ? `, ${formatEuro(info.contract_monthly_cents)}/Monat` : "") +
      (deadline ? `\nKündigen bis ${deadline.split("-").reverse().join(".")}` : "\nKündigungsfrist nicht erkannt – bitte ergänzen");
    const notify = src.owner?.notify_service ? [src.owner] : (await listUsers()).filter((u) => u.role === "admin" && u.notify_service);
    for (const u of notify) await this.ha.notify(u.notify_service!, "Vertrag erkannt", msg);
    return `Vertrag erkannt und erfasst. ${msg.replace("\n", " – ")}`;
  }

  private calendarFor(owner: AppUser | null): string | null {
    const cals = this.config.calendars;
    return (owner && cals.find((c) => c.owner.toLowerCase() === owner.name.toLowerCase())?.name)
      ?? cals.find((c) => c.owner === "shared")?.name
      ?? cals[0]?.name ?? null;
  }

  /** Termine werden nie still eingetragen, sondern zur Übernahme vorgeschlagen. */
  private async proposeAppointment(info: DocumentInfo, owner: AppUser | null, from: string): Promise<string> {
    const calendar = this.calendarFor(owner);
    if (!info.appointment_start || !calendar) return `Termin erkannt (${info.summary}), aber ${calendar ? "ohne Datum" : "kein Kalender konfiguriert"} – bitte selbst eintragen.`;
    const start = info.appointment_start;
    const end = info.appointment_end ?? new Date(Date.parse(start) + 3_600_000).toISOString();
    const title = info.appointment_title ?? info.summary;
    const when = new Date(start).toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" });
    const r = await this.actions.request("calendar_event", { calendar, title, start, end, location: info.appointment_location, notes: `Aus Dokument von ${from}` }, {
      agent: "family", summary: `${title}\n${when} in „${calendar}“${info.appointment_location ? `\n${info.appointment_location}` : ""}`, requestedBy: owner,
    });
    return `Termin erkannt: ${title} am ${when}. Übernahme in „${calendar}“ angefragt bei ${r.approvers.join(", ")}.`;
  }

  private async handleInvite(ics: string, owner: AppUser | null, from: string): Promise<void> {
    const calendar = this.calendarFor(owner);
    if (!calendar) return;
    for (const ev of parseEvents(ics, calendar)) {
      const start = ev.start.length === 10 ? `${ev.start}T00:00:00` : ev.start;
      const end = ev.end ? (ev.end.length === 10 ? `${ev.end}T00:00:00` : ev.end) : new Date(Date.parse(start) + 3_600_000).toISOString();
      const when = new Date(start).toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "short" });
      await this.actions.request("calendar_event", { calendar, title: ev.title, start, end, location: ev.location, notes: `Einladung von ${from}` }, {
        agent: "family", summary: `Einladung: ${ev.title}\n${when} in „${calendar}“`, requestedBy: owner,
      });
    }
  }
}
