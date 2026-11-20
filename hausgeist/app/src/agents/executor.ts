import { randomUUID } from "node:crypto";
import { db, audit, listUsers } from "../core/db.js";
import { formatEuro } from "../core/checks.js";
import type { PaymentProvider } from "../adapters/payment.js";
import type { HomeAssistant } from "../adapters/homeassistant.js";
import type { DocumentAgent } from "./document.js";
import { logger } from "../core/log.js";

const log = logger("executor");

/**
 * Ausführer für Stufe-2-Aktionen. Fester Code, kein Sprachmodell:
 * zahlt ausschließlich mit den eingefrorenen Werten der Freigabe.
 */
export class Executor {
  constructor(
    private readonly payments: PaymentProvider,
    private readonly ha: HomeAssistant,
    private readonly documents: DocumentAgent,
  ) {}

  async execute(approvalId: string): Promise<void> {
    const { data: a } = await db().from("approvals").select("*").eq("id", approvalId).single();
    if (!a || a.status !== "approved") {
      log.error(`Freigabe ${approvalId} nicht freigegeben – Abbruch`);
      return;
    }
    const { data: inv } = await db().from("invoices").select("id, issuer, status").eq("id", a.invoice_id).single();
    const { data: account } = a.account_id
      ? await db().from("accounts").select("iban, label").eq("id", a.account_id).single()
      : { data: null };

    const notifyDecider = async (title: string, msg: string) => {
      const users = await listUsers();
      const u = users.find((x) => x.id === a.decided_by);
      if (u?.notify_service) await this.ha.notify(u.notify_service, title, msg);
    };

    if (!inv || inv.status !== "approved") return;
    if (!account) {
      await db().from("invoices").update({ status: "failed", review_note: "Kein Zahlerkonto" }).eq("id", inv.id);
      await notifyDecider("Zahlung nicht möglich", `${inv.issuer}: kein Zahlerkonto hinterlegt.`);
      return;
    }

    await db().from("invoices").update({ status: "paying" }).eq("id", inv.id);
    const result = await this.payments.transfer({
      fromIban: account.iban,
      toIban: a.iban,
      toName: inv.issuer,
      amountCents: a.amount_cents,
      reference: a.reference ?? "",
      endToEndId: randomUUID().replace(/-/g, "").slice(0, 35),
    });

    if (result.status === "dryrun") {
      await db().from("invoices").update({ status: "approved", review_note: "Testmodus: nicht überwiesen" }).eq("id", inv.id);
      await notifyDecider("Testmodus", `${inv.issuer}: ${formatEuro(a.amount_cents)} von ${account.label} – nicht überwiesen.`);
      await audit({ agent: "executor", action: "transfer", level: 2, result: "dryrun", ref_table: "approvals", ref_id: approvalId });
      await this.fileInvoice(inv.id, ["Testmodus"]);
    } else if (result.status === "submitted") {
      await db().from("invoices").update({ status: "paid" }).eq("id", inv.id);
      await notifyDecider(
        "Überweisung übermittelt",
        `${inv.issuer}: ${formatEuro(a.amount_cents)} von ${account.label}.${result.needsBankApproval ? " Bitte in der Banking-App bestätigen." : ""}`,
      );
      await audit({ agent: "executor", action: "transfer", level: 2, result: "submitted", ref_table: "approvals", ref_id: approvalId, detail: result });
      await this.fileInvoice(inv.id, ["bezahlt"]);
    } else {
      await db().from("invoices").update({ status: "failed", review_note: result.error }).eq("id", inv.id);
      await notifyDecider("Zahlung fehlgeschlagen", `${inv.issuer}: ${result.error}`);
      await audit({ agent: "executor", action: "transfer", level: 2, result: "failed", ref_table: "approvals", ref_id: approvalId, detail: { error: result.error } });
    }
  }

  async fileInvoice(invoiceId: string, extraTags: string[]): Promise<void> {
    const { data: inv } = await db()
      .from("invoices")
      .select("id, source_sha256, issuer, invoice_number, invoice_date, category")
      .eq("id", invoiceId)
      .single();
    if (!inv) return;
    try {
      const taskId = await this.documents.file(inv.source_sha256, {
        filename: `${inv.issuer}-${inv.invoice_number ?? inv.id}.pdf`.replace(/[^\w.-]+/g, "_"),
        title: [inv.issuer, inv.invoice_number].filter(Boolean).join(" "),
        tags: ["Rechnung", inv.category ?? "", ...extraTags],
        created: inv.invoice_date,
        refId: inv.id,
      });
      if (taskId) await db().from("invoices").update({ paperless_task_id: taskId }).eq("id", inv.id);
    } catch (e) {
      log.error(`Ablage von ${inv.issuer} fehlgeschlagen`, e);
    }
  }
}
