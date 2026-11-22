import { db, audit, listUsers } from "../core/db.js";
import {
  approversFor, canApprove, duplicateKey, formatEuro, formatIban, isValidIban, normalizeIban,
  payeeStatus, suggestAccount, type AccountRule, type AppUser, type PayeeStatus,
} from "../core/checks.js";
import { HomeAssistant } from "../adapters/homeassistant.js";
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

/** Eine Zahlung, die freigegeben werden soll – aus einer Rechnung oder direkt aus dem Chat. */
export interface PaymentInput {
  source: string;               // Postfach, "app" oder "chat"
  messageId?: string | null;
  sha: string;                  // Hash des Dokuments oder "manual:<uuid>"
  issuer: string;
  iban: string | null;
  bic?: string | null;
  amount_cents: number;
  currency?: string;
  reference?: string | null;
  invoice_number?: string | null;
  invoice_date?: string | null;
  due_date?: string | null;
  recipient_name?: string | null;
  category?: string | null;
  suspicious?: string | null;
  accountLabel?: string | null; // Wunschkonto (Chat)
  requestedBy?: AppUser | null;
}

/**
 * Finance-Agent: prüft Zahlungen und holt die Freigabe ein. Die Zahlung
 * selbst führt der Executor mit den eingefrorenen Freigabewerten aus.
 */
export class FinanceAgent {
  constructor(
    private readonly ha: HomeAssistant,
    private readonly executor: Executor,
  ) {}

  /** Prüft eine Zahlung und legt sie zur Freigabe vor. Gibt eine kurze Statusmeldung zurück. */
  async createPaymentRequest(input: PaymentInput): Promise<{ status: "pending" | "needs_review"; message: string; invoiceId: string }> {
    const warnings: string[] = [];
    if (input.suspicious) warnings.push(`Auffällig: ${input.suspicious}`);
    const currency = (input.currency ?? "EUR").toUpperCase();
    const iban = input.iban ? normalizeIban(input.iban) : "";
    const users = await listUsers();
    const admins = users.filter((u) => u.role === "admin");

    if (!iban || !isValidIban(iban) || input.amount_cents <= 0 || currency !== "EUR") {
      const id = await this.needsReview(input, iban || "UNBEKANNT", "IBAN fehlt/ungültig, Betrag 0 oder keine Euro-Zahlung", admins);
      return { status: "needs_review", message: "Zur Prüfung beim Admin: IBAN fehlt oder ist ungültig, Betrag 0 oder keine Euro-Zahlung.", invoiceId: id };
    }

    const { data: payee } = await db().from("payees").select("id, ibans, default_account_id").ilike("name", input.issuer).maybeSingle();
    const pStatus = payeeStatus(iban, payee?.ibans ?? [], Boolean(payee));
    const dupKey = duplicateKey({ issuer: input.issuer, invoice_number: input.invoice_number ?? null, iban, amount_cents: input.amount_cents, invoice_date: input.invoice_date ?? null });
    const { data: dups } = await db().from("invoices").select("id").eq("duplicate_key", dupKey).neq("status", "rejected").limit(1);
    if (dups && dups.length > 0) {
      const id = await this.needsReview(input, iban, "Mögliche Doppelrechnung", admins, dupKey, pStatus);
      return { status: "needs_review", message: "Sieht nach einer Doppelrechnung aus – zur Prüfung beim Admin.", invoiceId: id };
    }

    const { data: accounts } = await db().from("accounts").select("id, label, match_names, is_default");
    const all = (accounts ?? []) as AccountRule[];
    const wanted = input.accountLabel ? all.find((a) => a.label.toLowerCase().includes(input.accountLabel!.toLowerCase())) : null;
    const account = wanted ?? suggestAccount(all, input.recipient_name ?? null, payee?.default_account_id ?? null);
    if (!account) warnings.push("Kein Zahlerkonto gefunden – bitte Konten anlegen");
    if (input.requestedBy) warnings.push(`Angefragt von ${input.requestedBy.name}`);

    const reference = input.reference ?? input.invoice_number ?? null;
    const { data: invoice, error } = await db()
      .from("invoices")
      .insert({
        mailbox: input.source, message_id: input.messageId ?? null, source_sha256: input.sha, duplicate_key: dupKey,
        issuer: input.issuer, recipient_name: input.recipient_name ?? null, invoice_number: input.invoice_number ?? null,
        invoice_date: input.invoice_date ?? null, due_date: input.due_date ?? null, amount_cents: input.amount_cents,
        currency: "EUR", iban, bic: input.bic ?? null, reference, category: input.category ?? null,
        payee_id: payee?.id ?? null, payee_status: pStatus, suggested_account_id: account?.id ?? null,
        status: "pending_approval", review_note: warnings.join(" | ") || null,
      })
      .select("id")
      .single();
    if (error) throw error;

    const { data: approval, error: aErr } = await db()
      .from("approvals")
      .insert({ invoice_id: invoice.id, amount_cents: input.amount_cents, iban, reference, account_id: account?.id ?? null, payee_status: pStatus })
      .select("id")
      .single();
    if (aErr) throw aErr;

    const recipients = approversFor(users, { amount_cents: input.amount_cents, payee_status: pStatus });
    const lines = [
      `${formatEuro(input.amount_cents)}${input.due_date ? `, fällig ${input.due_date.split("-").reverse().join(".")}` : ""}`,
      `${formatIban(iban)} – ${statusLabel[pStatus]}`,
      `Von Konto: ${account?.label ?? "—"}`,
      input.recipient_name ? `Rechnung an: ${input.recipient_name}` : "",
      reference ? `Zweck: ${reference}` : "",
      ...warnings.map((w) => `⚠️ ${w}`),
    ].filter(Boolean);

    for (const u of recipients) {
      await this.ha.notify(u.notify_service!, `Zahlung: ${input.issuer}`, lines.join("\n"), [
        { action: `${ACTION_APPROVE}${approval.id}`, title: "Freigeben" },
        { action: `${ACTION_REJECT}${approval.id}`, title: "Ablehnen", destructive: true },
      ], `hg-${approval.id}`);
    }
    if (recipients.length === 0) log.warn("Niemand darf diese Zahlung freigeben – Nutzer und notify_service prüfen");
    await audit({ agent: "finance", action: "request_approval", level: 2, result: "pending", user_id: input.requestedBy?.id, ref_table: "invoices", ref_id: invoice.id, detail: { approvers: recipients.map((u) => u.name), payee_status: pStatus, source: input.source } });
    log.info(`Freigabe angefragt: ${input.issuer} ${formatEuro(input.amount_cents)}`);
    return {
      status: "pending",
      message: `Freigabe angefragt bei ${recipients.map((u) => u.name).join(", ") || "niemandem (Benachrichtigungen fehlen)"}: ${formatEuro(input.amount_cents)} an ${input.issuer}, ${statusLabel[pStatus]}, Konto ${account?.label ?? "—"}.`,
      invoiceId: invoice.id,
    };
  }

  private async needsReview(input: PaymentInput, iban: string, reason: string, admins: AppUser[], dupKey?: string, pStatus: PayeeStatus = "new"): Promise<string> {
    const { data: inv, error } = await db().from("invoices").insert({
      mailbox: input.source, message_id: input.messageId ?? null, source_sha256: input.sha,
      duplicate_key: dupKey ?? duplicateKey({ issuer: input.issuer, invoice_number: input.invoice_number ?? null, iban, amount_cents: input.amount_cents, invoice_date: input.invoice_date ?? null }),
      issuer: input.issuer || "Unbekannt", recipient_name: input.recipient_name ?? null, invoice_number: input.invoice_number ?? null,
      invoice_date: input.invoice_date ?? null, due_date: input.due_date ?? null, amount_cents: Math.max(input.amount_cents, 1),
      currency: input.currency || "EUR", iban, bic: input.bic ?? null, reference: input.reference ?? null, category: input.category ?? null,
      payee_status: pStatus, status: "needs_review", review_note: reason,
    }).select("id").single();
    if (error) throw error;
    for (const a of admins.filter((u) => u.notify_service)) {
      await this.ha.notify(a.notify_service!, `Zahlung prüfen: ${input.issuer}`, `${reason}\n${formatEuro(input.amount_cents)} – keine Zahlung angestoßen.`);
    }
    await audit({ agent: "finance", action: "needs_review", level: 1, result: reason, ref_table: "invoices", ref_id: inv.id });
    log.warn(`Zur Prüfung: ${input.issuer} – ${reason}`);
    return inv.id;
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
    const r = await this.decide(user, approvalId, approve);
    if (!r.ok && user.notify_service) await this.ha.notify(user.notify_service, "Freigabe nicht möglich", r.message);
  }

  /** Entscheidung über eine Zahlungsfreigabe – aus der HA-Benachrichtigung oder der App. */
  async decide(user: AppUser, approvalId: string, approve: boolean): Promise<{ ok: boolean; message: string }> {
    const { data: approval } = await db().from("approvals").select("*").eq("id", approvalId).maybeSingle();
    if (!approval || approval.status !== "pending") return { ok: false, message: "Diese Freigabe ist bereits entschieden." };

    if (approve) {
      const check = canApprove(user, { amount_cents: approval.amount_cents, payee_status: approval.payee_status });
      if (!check.allowed) {
        await audit({ agent: "finance", action: "decision", level: 2, result: "denied", user_id: user.id, ref_table: "approvals", ref_id: approvalId, detail: { reason: check.reason } });
        return { ok: false, message: check.reason };
      }
    } else if (user.role === "child") {
      return { ok: false, message: "Kinder können keine Zahlungen entscheiden." };
    }

    // Bedingtes Update: wer zuerst entscheidet, gewinnt.
    const { data: updated } = await db()
      .from("approvals")
      .update({ status: approve ? "approved" : "rejected", decided_by: user.id, decided_at: new Date().toISOString() })
      .eq("id", approvalId)
      .eq("status", "pending")
      .select("*");
    if (!updated || updated.length === 0) return { ok: false, message: "Diese Freigabe ist bereits entschieden." };

    await db().from("invoices").update({ status: approve ? "approved" : "rejected" }).eq("id", approval.invoice_id);
    await audit({ agent: "finance", action: "decision", level: 2, result: approve ? "approved" : "rejected", user_id: user.id, ref_table: "approvals", ref_id: approvalId });
    log.info(`${user.name} hat ${approve ? "freigegeben" : "abgelehnt"}`);

    if (approve) {
      // Admin-Freigabe bestätigt einen neuen Empfänger bzw. eine neue IBAN.
      if (approval.payee_status !== "known") await this.confirmPayee(approval.invoice_id, approval.iban);
      await this.executor.execute(approvalId);
      return { ok: true, message: "Freigegeben" };
    }
    await this.executor.fileInvoice(approval.invoice_id, ["abgelehnt"]);
    return { ok: true, message: "Abgelehnt" };
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
