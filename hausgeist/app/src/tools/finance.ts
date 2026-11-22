import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { db } from "../core/db.js";
import { randomUUID } from "node:crypto";
import { formatEuro, isValidIban, normalizeIban } from "../core/checks.js";
import { ok, safe, requireAdult, requireAdmin, type ToolContext } from "./context.js";

export function financeTools(ctx: ToolContext) {
  return [
    tool("list_invoices", "Rechnungen auflisten, optional nach Status und Zeitraum.", {
      status: z.enum(["pending_approval", "approved", "rejected", "paying", "paid", "failed", "needs_review"]).optional(),
      since: z.string().optional().describe("Datum JJJJ-MM-TT"),
      limit: z.number().int().min(1).max(100).default(20),
    }, safe(async (a) => {
      requireAdult(ctx);
      let q = db().from("invoices")
        .select("id, issuer, amount_cents, due_date, status, category, recipient_name, created_at, review_note")
        .order("created_at", { ascending: false }).limit(a.limit);
      if (a.status) q = q.eq("status", a.status);
      if (a.since) q = q.gte("created_at", a.since);
      const { data, error } = await q;
      if (error) throw error;
      return ok((data ?? []).map((i) => ({ ...i, betrag: formatEuro(i.amount_cents) })));
    })),

    tool("spending_summary", "Ausgaben aus Rechnungen nach Kategorie und Monat, verglichen mit den Budgets.", {
      months: z.number().int().min(1).max(24).default(3),
    }, safe(async (a) => {
      requireAdult(ctx);
      const since = new Date();
      since.setMonth(since.getMonth() - a.months);
      const { data, error } = await db().from("invoices")
        .select("amount_cents, category, invoice_date, created_at, status")
        .in("status", ["paid", "approved", "pending_approval"])
        .gte("created_at", since.toISOString());
      if (error) throw error;
      const sums: Record<string, Record<string, number>> = {};
      for (const i of data ?? []) {
        const month = String(i.invoice_date ?? i.created_at).slice(0, 7);
        const cat = i.category ?? "Sonstiges";
        sums[month] ??= {};
        sums[month][cat] = (sums[month][cat] ?? 0) + i.amount_cents;
      }
      const { data: budgets } = await db().from("budgets").select("category, monthly_cents");
      return ok({ ausgaben_cent: sums, budgets_cent: budgets ?? [] });
    })),

    tool("set_budget", "Monatsbudget für eine Kategorie setzen (Stufe 1).", {
      category: z.string(),
      monthly_euro: z.number().nonnegative(),
    }, safe(async (a) => {
      requireAdult(ctx);
      const { error } = await db().from("budgets").upsert({ category: a.category, monthly_cents: Math.round(a.monthly_euro * 100) }, { onConflict: "category" });
      if (error) throw error;
      return ok(`Budget ${a.category}: ${formatEuro(Math.round(a.monthly_euro * 100))} pro Monat`);
    })),

    tool("list_accounts_and_payees", "Eigene Konten und bekannte Zahlungsempfänger anzeigen.", {}, safe(async () => {
      requireAdult(ctx);
      const [{ data: accounts }, { data: payees }] = await Promise.all([
        db().from("accounts").select("label, bank, is_default, match_names"),
        db().from("payees").select("name, ibans"),
      ]);
      return ok({ accounts, payees });
    })),

    tool("pending_approvals", "Offene Freigaben (Zahlungen und andere Aktionen).", {}, safe(async () => {
      requireAdult(ctx);
      const [{ data: pays }, { data: acts }] = await Promise.all([
        db().from("approvals").select("id, amount_cents, payee_status, created_at, invoices(issuer, due_date)").eq("status", "pending"),
        db().from("actions").select("id, kind, summary, created_at").eq("status", "pending"),
      ]);
      return ok({ zahlungen: pays ?? [], aktionen: acts ?? [] });
    })),

    tool("request_payment", "Überweisung ohne Rechnungsmail zur Freigabe vorlegen (Stufe 2), z. B. „Überweise 50 € an X“. Gleiche Prüfungen wie bei Rechnungen; neue IBAN braucht immer den Admin.", {
      payee: z.string().describe("Name des Empfängers"),
      iban: z.string(),
      amount_euro: z.number().positive(),
      reference: z.string().describe("Verwendungszweck"),
      due_date: z.string().optional().describe("JJJJ-MM-TT"),
      account: z.string().optional().describe("Wunschkonto, z. B. DKB"),
      category: z.string().optional(),
    }, safe(async (a) => {
      requireAdult(ctx);
      const r = await ctx.finance.createPaymentRequest({
        source: "chat", sha: `manual:${randomUUID()}`, issuer: a.payee, iban: a.iban,
        amount_cents: Math.round(a.amount_euro * 100), reference: a.reference, due_date: a.due_date ?? null,
        accountLabel: a.account ?? null, category: a.category ?? null, requestedBy: ctx.user,
      });
      return ok(r.message);
    })),

    tool("add_account", "Eigenes Bankkonto anlegen (nur Admin).", {
      label: z.string().describe("z. B. Sparkasse Giro"),
      bank: z.enum(["sparkasse_duisburg", "deutsche_bank", "dkb"]),
      iban: z.string(),
      holder: z.string().optional().describe("Name des Inhabers aus dem Haushalt"),
      match_names: z.array(z.string()).default([]).describe("Namen auf Rechnungen, die von diesem Konto bezahlt werden"),
      is_default: z.boolean().default(false),
    }, safe(async (a) => {
      requireAdmin(ctx);
      if (!isValidIban(a.iban)) throw new Error("IBAN ist ungültig");
      let holder: string | null = null;
      if (a.holder) {
        const { data } = await db().from("users").select("id").ilike("name", a.holder).maybeSingle();
        holder = data?.id ?? null;
      }
      if (a.is_default) await db().from("accounts").update({ is_default: false }).eq("is_default", true);
      const { error } = await db().from("accounts").insert({
        label: a.label, bank: a.bank, iban: normalizeIban(a.iban), holder_id: holder, match_names: a.match_names, is_default: a.is_default,
      });
      if (error) throw error;
      return ok(`Konto ${a.label} angelegt`);
    })),

    tool("add_payee", "Zahlungsempfänger mit geprüfter IBAN hinterlegen (nur Admin). Danach gelten Rechnungen mit dieser IBAN als bekannt.", {
      name: z.string(),
      iban: z.string(),
      default_account: z.string().optional().describe("Konto-Bezeichnung, von dem bezahlt wird"),
    }, safe(async (a) => {
      requireAdmin(ctx);
      if (!isValidIban(a.iban)) throw new Error("IBAN ist ungültig");
      let accountId: string | null = null;
      if (a.default_account) {
        const { data } = await db().from("accounts").select("id").ilike("label", `%${a.default_account}%`).limit(1);
        accountId = data?.[0]?.id ?? null;
      }
      const iban = normalizeIban(a.iban);
      const { data: existing } = await db().from("payees").select("id, ibans").ilike("name", a.name).maybeSingle();
      if (existing) {
        const ibans = Array.from(new Set([...(existing.ibans ?? []), iban]));
        await db().from("payees").update({ ibans, ...(accountId ? { default_account_id: accountId } : {}) }).eq("id", existing.id);
      } else {
        const { error } = await db().from("payees").insert({ name: a.name, ibans: [iban], default_account_id: accountId });
        if (error) throw error;
      }
      return ok(`${a.name} mit IBAN hinterlegt`);
    })),

    tool("process_upload_as_invoice", "Eine in der App hochgeladene Rechnung (Foto oder PDF) einlesen und zur Zahlung vorlegen.", {
      upload_id: z.string().uuid(),
    }, safe(async (a) => ok(await ctx.intake.handleFile(await uploadSource(ctx, a.upload_id))))),
  ];
}

async function uploadSource(ctx: ToolContext, id: string) {
  const { getUpload } = await import("../core/uploads.js");
  const { isSupportedMime } = await import("../agents/extract.js");
  const up = getUpload(id);
  if (!up) throw new Error("Datei nicht gefunden");
  if (up.meta.userId !== ctx.user.id && ctx.user.role === "child") throw new Error("Keine Berechtigung");
  if (!isSupportedMime(up.meta.mime)) throw new Error(`Dateityp ${up.meta.mime} wird nicht unterstützt`);
  return { source: "app", filename: up.meta.name, data: up.data, mime: up.meta.mime, owner: ctx.user };
}

export { uploadSource };
