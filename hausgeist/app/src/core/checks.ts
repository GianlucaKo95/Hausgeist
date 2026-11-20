// Reine Prüflogik ohne Seiteneffekte – bewusst getrennt, damit sie testbar ist
// und kein Sprachmodell an Freigabe- oder Zahlungsentscheidungen beteiligt ist.

export type Role = "admin" | "adult" | "child";

export interface AppUser {
  id: string;
  name: string;
  role: Role;
  approval_limit_cents: number;
  ha_user_id: string | null;
  notify_service: string | null;
}

export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/** Prüfsumme nach ISO 13616 (mod 97). */
export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= "A" && ch <= "Z" ? (ch.charCodeAt(0) - 55).toString() : ch;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function formatIban(raw: string): string {
  return normalizeIban(raw).replace(/(.{4})/g, "$1 ").trim();
}

export function formatEuro(cents: number): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(cents / 100);
}

export type PayeeStatus = "known" | "new" | "iban_changed";

export function payeeStatus(
  iban: string,
  knownIbansForPayee: string[],
  payeeExists: boolean,
): PayeeStatus {
  const n = normalizeIban(iban);
  if (!payeeExists) return "new";
  return knownIbansForPayee.map(normalizeIban).includes(n) ? "known" : "iban_changed";
}

export interface ApprovalRequest {
  amount_cents: number;
  payee_status: PayeeStatus;
}

export type ApprovalDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Darf dieser Nutzer diese Zahlung freigeben?
 * - Kinder nie.
 * - Neue oder geänderte Empfänger-IBAN nur Admin.
 * - Erwachsene bis zu ihrem Limit (Standard 500 €), darüber nur Admin.
 */
export function canApprove(user: AppUser, req: ApprovalRequest): ApprovalDecision {
  if (user.role === "child") return { allowed: false, reason: "Kinder können keine Zahlungen freigeben." };
  if (req.payee_status !== "known" && user.role !== "admin")
    return { allowed: false, reason: "Neue oder geänderte IBAN – nur der Admin kann freigeben." };
  if (user.role === "adult" && req.amount_cents > user.approval_limit_cents)
    return {
      allowed: false,
      reason: `Betrag über deinem Limit von ${formatEuro(user.approval_limit_cents)} – nur der Admin kann freigeben.`,
    };
  return { allowed: true };
}

/** Wer bekommt die Freigabe-Nachricht? Alle, die freigeben dürften. */
export function approversFor(users: AppUser[], req: ApprovalRequest): AppUser[] {
  return users.filter((u) => u.notify_service && canApprove(u, req).allowed);
}

/** Schlüssel zur Dublettenerkennung: gleicher Aussteller + Rechnungsnummer, sonst Betrag + IBAN + Datum. */
export function duplicateKey(inv: {
  issuer: string;
  invoice_number: string | null;
  iban: string;
  amount_cents: number;
  invoice_date: string | null;
}): string {
  const issuer = inv.issuer.trim().toLowerCase().replace(/\s+/g, " ");
  if (inv.invoice_number) return `nr:${issuer}:${inv.invoice_number.trim().toLowerCase()}`;
  return `amt:${normalizeIban(inv.iban)}:${inv.amount_cents}:${inv.invoice_date ?? "?"}`;
}

export type ActionKind = "send_mail" | "order" | "ha_service" | "calendar_event";

/**
 * Freigaberechte für Stufe-2-Aktionen außer Zahlungen.
 * - Kinder nie.
 * - Bestellungen: Erwachsene bis zu ihrem Limit, darüber nur Admin.
 * - Mail senden: nur der Besitzer des Postfachs oder der Admin.
 * - Alles andere: Erwachsene und Admin.
 */
export function canApproveAction(
  user: AppUser,
  action: { kind: ActionKind; amount_cents: number | null; mailbox_owner_id?: string | null },
): ApprovalDecision {
  if (user.role === "child") return { allowed: false, reason: "Kinder können keine Aktionen freigeben." };
  if (action.kind === "order" && user.role === "adult" && (action.amount_cents ?? 0) > user.approval_limit_cents)
    return { allowed: false, reason: `Bestellung über deinem Limit von ${formatEuro(user.approval_limit_cents)} – nur der Admin kann freigeben.` };
  if (action.kind === "send_mail" && user.role !== "admin" && action.mailbox_owner_id && action.mailbox_owner_id !== user.id)
    return { allowed: false, reason: "Nur der Besitzer des Postfachs oder der Admin kann diese Mail freigeben." };
  return { allowed: true };
}

/** Home-Assistant-Domains, deren Dienste immer eine Freigabe brauchen. */
export const SENSITIVE_HA_DOMAINS = ["lock", "alarm_control_panel", "cover", "siren", "valve"];

export function isSensitiveHaService(domain: string): boolean {
  return SENSITIVE_HA_DOMAINS.includes(domain);
}

/** Entity-Whitelist mit einfachen Platzhaltern, z. B. "climate.*" oder "sensor.pv_*". */
export function entityAllowed(entityId: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    const re = new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    return re.test(entityId);
  });
}

/** Spätester Kündigungstermin: Vertragsende minus Kündigungsfrist. */
export function noticeDeadline(endDate: string | null, noticeDays: number | null): string | null {
  if (!endDate || noticeDays == null) return null;
  const d = new Date(`${endDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - noticeDays);
  return d.toISOString().slice(0, 10);
}

export interface AccountRule {
  id: string;
  label: string;
  match_names: string[];
  is_default: boolean;
}

/**
 * Zahlerkonto vorschlagen: 1. Standardkonto des Zahlungsempfängers,
 * 2. Konto, dessen Namensliste zum Rechnungsempfänger passt, 3. Standardkonto.
 */
export function suggestAccount(
  accounts: AccountRule[],
  recipientName: string | null,
  payeeDefaultAccountId: string | null,
): AccountRule | null {
  if (payeeDefaultAccountId) {
    const a = accounts.find((x) => x.id === payeeDefaultAccountId);
    if (a) return a;
  }
  if (recipientName) {
    const r = recipientName.toLowerCase();
    const hit = accounts.find((a) => a.match_names.some((n) => n && r.includes(n.toLowerCase())));
    if (hit) return hit;
  }
  return accounts.find((a) => a.is_default) ?? null;
}
