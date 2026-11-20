import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import type { Config } from "../core/config.js";
import { db, audit, listUsers } from "../core/db.js";
import {
  approversFor, canApprove, duplicateKey, formatEuro, formatIban, isValidIban, normalizeIban,
  payeeStatus, suggestAccount, type AccountRule, type AppUser, type PayeeStatus,
} from "../core/checks.js";
import { HomeAssistant } from "../adapters/homeassistant.js";
import { extractInvoice, type InvoiceData } from "./extract.js";
import type { IncomingMail } from "./communication.js";
import type { DocumentAgent } from "./document.js";
import type { Executor } from "./executor.js";
import { logger } from "../core/log.js";

const log = logger("finance");

export const ACTION_APPROVE = "HG_APPROVE:";
export const ACTION_REJECT = "HG_REJECT:";

const statusLabel: Record<PayeeStatus, string> = {
  known: "✅ bekannte IBAN",
  new: "⚠️ NEUER Empfänger",
  iban_changed: "🚨 IBAN GEÄNDERT",
};

/**
 * Finance-Agent, Phase 1: liest Rechnungen aus, prüft sie und holt die
 * Freigabe ein. Die Zahlung selbst führt der Executor mit den eingefrorenen
 * Freigabewerten aus.
 */
export class FinanceAgent {
  private readonly llm: Anthropic;

  constructor(
    private readonly config: Config,
    private readonly ha: HomeAssistant,
    private readonly documents: DocumentAgent,
    private readonly executor: Executor,
  ) {
    this.llm = new Anthropic({ apiKey: config.anthropic_api_key });
  }

  async handleMail(mail: IncomingMail): Promise<void> {
    for (const pdf of mail.pdfs) {
      const sha = createHash("sha256").update(pdf.content).digest("hex");
      const { data: seen } = await db().from("invoices").select("id").eq("source_sha256", sha).maybeSingle();
      if (seen) {
        log.debug(`${pdf.filename} bereits verarbeitet`);
        continue;
      }
      try {
        await this.handlePdf(mail, pdf.filename, pdf.content, sha);
      } catch (e) {
        log.error(`${pdf.filename} aus ${mail.mailbox} fehlgeschlagen`, e);
        await audit({ agent: "finance", action: "read_invoice", level: 0, result: "error", detail: { file: pdf.filename, error: String(e) } });
      }
    }
  }

  private async handlePdf(mail: IncomingMail, filename: string, pdf: Buffer, sha: string): Promise<void> {
    const data = await extractInvoice(this.llm, this.config.model, pdf, mail);
    this.documents.keep(sha, pdf);
    await audit({ agent: "finance", action: "read_invoice", level: 0, result: "ok", detail: { file: filename, issuer: data.issuer, is_invoice: data.is_invoice } });

    // Keine Rechnung oder nichts zu überweisen: nur ablegen.
    if (!data.is_invoice || !data.needs_payment) {
      await this.documents.file(sha, {
        filename,
        title: [data.issuer, data.invoice_number].filter(Boolean).join(" ") || mail.subject || filename,
        tags: data.is_invoice ? ["Rechnung", "keine Überweisung", data.category ?? ""] : ["Posteingang"],
        created: data.invoice_date,
      });
      return;
    }

    const warnings: string[] = [];
    if (data.suspicious) warnings.push(`Auffällig: ${data.suspicious}`);
    if (data.currency.toUpperCase() !== "EUR") warnings.push(`Währung ${data.currency}`);

    const iban = data.iban ? normalizeIban(data.iban) : "";
    const users = await listUsers();
    const admins = users.filter((u) => u.role === "admin");

    if (!iban || !isValidIban(iban) || data.amount_cents <= 0 || data.currency.toUpperCase() !== "EUR") {
      await this.needsReview(mail, data, sha, iban || "UNBEKANNT", "IBAN fehlt/ungültig, Betrag 0 oder keine Euro-Rechnung", admins);
      return;
    }

    const { data: payee } = await db().from("payees").select("id, ibans, default_account_id").ilike("name", data.issuer).maybeSingle();
    const pStatus = payeeStatus(iban, payee?.ibans ?? [], Boolean(payee));
    const dupKey = duplicateKey({ ...data, iban });
    const { data: dups } = await db().from("invoices").select("id").eq("duplicate_key", dupKey).neq("status", "rejected").limit(1);
    if (dups && dups.length > 0) {
      await this.needsReview(mail, data, sha, iban, "Mögliche Doppelrechnung", admins, dupKey, pStatus);
      return;
    }

    const { data: accounts } = await db().from("accounts").select("id, label, match_names, is_default");
    const account = suggestAccount((accounts ?? []) as AccountRule[], data.recipient_name, payee?.default_account_id ?? null);
    if (!account) warnings.push("Kein Zahlerkonto gefunden – bitte Konten in Supabase anlegen");

    const { data: invoice, error } = await db()
      .from("invoices")
      .insert({
        mailbox: mail.mailbox, message_id: mail.messageId, source_sha256: sha, duplicate_key: dupKey,
        issuer: data.issuer, recipient_name: data.recipient_name, invoice_number: data.invoice_number,
        invoice_date: data.invoice_date, due_date: data.due_date, amount_cents: data.amount_cents,
        currency: "EUR", iban, bic: data.bic, reference: data.reference ?? data.invoice_number,
        category: data.category, payee_id: payee?.id ?? null, payee_status: pStatus,
        suggested_account_id: account?.id ?? null, status: "pending_approval",
        review_note: warnings.join(" | ") || null,
      })
      .select("id")
      .single();
    if (error) throw error;

    const { data: approval, error: aErr } = await db()
      .from("approvals")
      .insert({
        invoice_id: invoice.id, amount_cents: data.amount_cents, iban,
        reference: data.reference ?? data.invoice_number, account_id: account?.id ?? null, payee_status: pStatus,
      })
      .select("id")
      .single();
    if (aErr) throw aErr;

    const req = { amount_cents: data.amount_cents, payee_status: pStatus };
    const recipients = approversFor(users, req);
    const lines = [
      `${formatEuro(data.amount_cents)}${data.due_date ? `, fällig ${data.due_date.split("-").reverse().join(".")}` : ""}`,
      `${formatIban(iban)} – ${statusLabel[pStatus]}`,
      `Von Konto: ${account?.label ?? "—"}`,
      data.recipient_name ? `Rechnung an: ${data.recipient_name}` : "",
      data.reference ? `Zweck: ${data.reference}` : "",
      ...warnings.map((w) => `⚠️ ${w}`),
    ].filter(Boolean);

    for (const u of recipients) {
      await this.ha.notify(u.notify_service!, `Rechnung: ${data.issuer}`, lines.join("\n"), [
        { action: `${ACTION_APPROVE}${approval.id}`, title: "Freigeben" },
        { action: `${ACTION_REJECT}${approval.id}`, title: "Ablehnen", destructive: true },
      ], `hg-${approval.id}`);
    }
    if (recipients.length === 0) log.warn("Niemand darf diese Rechnung freigeben – Nutzer und notify_service prüfen");
    await audit({ agent: "finance", action: "request_approval", level: 2, result: "pending", ref_table: "invoices", ref_id: invoice.id, detail: { approvers: recipients.map((u) => u.name), payee_status: pStatus } });
    log.info(`Freigabe angefragt: ${data.issuer} ${formatEuro(data.amount_cents)}`);
  }

  private async needsReview(
    mail: IncomingMail, data: InvoiceData, sha: string, iban: string, reason: string, admins: AppUser[],
    dupKey?: string, pStatus: PayeeStatus = "new",
  ): Promise<void> {
    const { data: inv, error } = await db().from("invoices").insert({
      mailbox: mail.mailbox, message_id: mail.messageId, source_sha256: sha,
      duplicate_key: dupKey ?? duplicateKey({ ...data, iban }), issuer: data.issuer || "Unbekannt",
      recipient_name: data.recipient_name, invoice_number: data.invoice_number, invoice_date: data.invoice_date,
      due_date: data.due_date, amount_cents: Math.max(data.amount_cents, 1), currency: data.currency || "EUR",
      iban, bic: data.bic, reference: data.reference, category: data.category, payee_status: pStatus,
      status: "needs_review", review_note: reason,
    }).select("id").single();
    if (error) throw error;
    for (const a of admins.filter((u) => u.notify_service)) {
      await this.ha.notify(a.notify_service!, `Rechnung prüfen: ${data.issuer}`, `${reason}\n${formatEuro(data.amount_cents)} – keine Zahlung angestoßen.`);
    }
    await audit({ agent: "finance", action: "needs_review", level: 1, result: reason, ref_table: "invoices", ref_id: inv.id });
    log.warn(`Zur Prüfung: ${data.issuer} – ${reason}`);
  }

  /** Klick auf "Freigeben"/"Ablehnen" in der Home-Assistant-App. */
  async handleAction(action: string, haUserId: string | null): Promise<void> {
    const approve = action.startsWith(ACTION_APPROVE);
    if (!approve && !action.startsWith(ACTION_REJECT)) return;
    const approvalId = action.slice((approve ? ACTION_APPROVE : ACTION_REJECT).length);

    const users = await listUsers();
    const user = users.find((u) => u.ha_user_id && u.ha_user_id === haUserId);
    if (!user) {
      log.warn(`Freigabe von unbekanntem HA-Nutzer ${haUserId} ignoriert`);
      await audit({ agent: "finance", action: "decision", level: 2, result: "unknown_user", detail: { haUserId, approvalId } });
      return;
    }

    const { data: approval } = await db().from("approvals").select("*").eq("id", approvalId).maybeSingle();
    if (!approval || approval.status !== "pending") {
      if (user.notify_service) await this.ha.notify(user.notify_service, "Hausgeist", "Diese Freigabe ist bereits entschieden.");
      return;
    }

    if (approve) {
      const check = canApprove(user, { amount_cents: approval.amount_cents, payee_status: approval.payee_status });
      if (!check.allowed) {
        if (user.notify_service) await this.ha.notify(user.notify_service, "Freigabe nicht möglich", check.reason);
        await audit({ agent: "finance", action: "decision", level: 2, result: "denied", user_id: user.id, ref_table: "approvals", ref_id: approvalId, detail: { reason: check.reason } });
        return;
      }
    }

    // Bedingtes Update: wer zuerst entscheidet, gewinnt.
    const { data: updated } = await db()
      .from("approvals")
      .update({ status: approve ? "approved" : "rejected", decided_by: user.id, decided_at: new Date().toISOString() })
      .eq("id", approvalId)
      .eq("status", "pending")
      .select("*");
    if (!updated || updated.length === 0) return;

    await db().from("invoices").update({ status: approve ? "approved" : "rejected" }).eq("id", approval.invoice_id);
    await audit({ agent: "finance", action: "decision", level: 2, result: approve ? "approved" : "rejected", user_id: user.id, ref_table: "approvals", ref_id: approvalId });
    log.info(`${user.name} hat ${approve ? "freigegeben" : "abgelehnt"}`);

    if (approve) {
      // Admin-Freigabe bestätigt einen neuen Empfänger bzw. eine neue IBAN.
      if (approval.payee_status !== "known") await this.confirmPayee(approval.invoice_id, approval.iban);
      await this.executor.execute(approvalId);
    } else {
      await this.executor.fileInvoice(approval.invoice_id, ["abgelehnt"]);
    }
  }

  private async confirmPayee(invoiceId: string, iban: string): Promise<void> {
    const { data: inv } = await db().from("invoices").select("issuer, payee_id, suggested_account_id").eq("id", invoiceId).single();
    if (!inv) return;
    if (inv.payee_id) {
      const { data: p } = await db().from("payees").select("ibans").eq("id", inv.payee_id).single();
      const ibans = Array.from(new Set([...(p?.ibans ?? []), iban]));
      await db().from("payees").update({ ibans }).eq("id", inv.payee_id);
    } else {
      const { data: p } = await db()
        .from("payees")
        .insert({ name: inv.issuer, ibans: [iban], default_account_id: inv.suggested_account_id })
        .select("id")
        .single();
      if (p) await db().from("invoices").update({ payee_id: p.id }).eq("id", invoiceId);
    }
  }
}
