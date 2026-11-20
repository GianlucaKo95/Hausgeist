import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { db } from "../core/db.js";
import { formatEuro } from "../core/checks.js";
import { ok, safe, requireAdult, type ToolContext } from "./context.js";

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
  ];
}
