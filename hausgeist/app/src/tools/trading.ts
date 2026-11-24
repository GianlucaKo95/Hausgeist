import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { db } from "../core/db.js";
import { fetchQuote, loadState, runDay, setStrategy, startPortfolio, valuation } from "../core/paper-trading.js";
import { ok, requireAdmin, safe, type ToolContext } from "./context.js";

/** Kurs-Abfrage – auch für den Strategie-Agenten im Abendlauf. */
export function quoteTool() {
  return tool("get_quote", "Schlusskurse der letzten 3 Monate für ein Symbol (Yahoo-Format, z. B. SAP.DE, MSFT, EUNL.DE).", {
    symbol: z.string().min(1).max(20),
  }, safe(async (a) => {
    const q = await fetchQuote(a.symbol.trim().toUpperCase());
    const c = q.closes;
    const chg = (n: number) => c.length > n ? Math.round((q.close / c[c.length - 1 - n].close - 1) * 1000) / 10 : null;
    return ok({ symbol: q.symbol, name: q.name, waehrung: q.currency, schluss: q.close, stand: q.day, veraenderung_prozent: { tag: chg(1), woche: chg(5), monat: chg(21), drei_monate: chg(c.length - 1) }, letzte_10: c.slice(-10) });
  }));
}

/**
 * Musterdepot (nur Papier). Nur der Admin – echte Orders gibt es nicht.
 */
export function tradingTools(ctx: ToolContext) {
  const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  return [
    quoteTool(),

    tool("paper_start", "Musterdepot starten oder komplett neu beginnen (setzt alles zurück). Nur nach ausdrücklichem Wunsch.", {
      start_cash_eur: z.number().min(1000).max(10_000_000),
      strategy: z.string().min(20).max(6000).describe("Strategie in Worten, wie der Nutzer sie beschreibt"),
      benchmark: z.string().default("EUNL.DE").describe("Vergleichs-ETF, Standard iShares Core MSCI World (EUNL.DE)"),
      watchlist: z.array(z.string()).max(60).default([]),
    }, safe(async (a) => {
      requireAdmin(ctx);
      const s = await startPortfolio(a.start_cash_eur, a.strategy, a.benchmark.toUpperCase(), a.watchlist.map((w) => w.toUpperCase()));
      return ok(`Musterdepot gestartet: ${s.start_cash_eur} €, Vergleich ${s.benchmark}, Strategie Version ${s.strategy_version}. Abendlauf werktags ab ${s.report_time} Uhr.`);
    })),

    tool("paper_overview", "Stand des Musterdepots: Positionen, Bargeld, Wertentwicklung im Vergleich zum ETF, aktuelle Strategie.", {}, safe(async () => {
      requireAdmin(ctx);
      const v = await valuation();
      return ok({ strategie: v.state.strategy, version: v.state.strategy_version, seit: v.state.started_at, start_eur: v.state.start_cash_eur, wert_eur: v.equity, bargeld_eur: v.cash, entwicklung_prozent: v.perf, vergleich: { symbol: v.state.benchmark, wert_eur: v.benchmark, prozent: v.benchPerf }, positionen: v.positions, beobachtung: v.state.watchlist, bericht_um: v.state.report_time, aktiv: v.state.enabled });
    })),

    tool("paper_update_strategy", "Strategie anpassen (neue Version, alte bleibt in der Historie). Immer den VOLLSTÄNDIGEN neuen Strategietext übergeben – bisherige Regeln übernehmen, die nicht geändert werden sollen.", {
      strategy: z.string().min(20).max(6000),
      note: z.string().max(300).optional().describe("Was sich geändert hat"),
    }, safe(async (a) => {
      requireAdmin(ctx);
      const v = await setStrategy(a.strategy, a.note);
      return ok(`Strategie Version ${v} gespeichert – gilt ab dem nächsten Abendlauf.`);
    })),

    tool("paper_strategy_history", "Frühere Strategie-Versionen.", {}, safe(async () => {
      requireAdmin(ctx);
      const { data } = await db().from("trading_strategy_history").select("version, note, changed_at, strategy").order("version", { ascending: false }).limit(10);
      return ok(data ?? []);
    })),

    tool("paper_settings", "Einstellungen: Beobachtungsliste, Uhrzeit des Abendberichts, Abendlauf an/aus.", {
      add_watch: z.array(z.string()).optional(),
      remove_watch: z.array(z.string()).optional(),
      report_time: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("z. B. 18:00 (nach Xetra-Schluss) oder 22:15 (nach US-Schluss)"),
      enabled: z.boolean().optional(),
    }, safe(async (a) => {
      requireAdmin(ctx);
      const s = await loadState();
      if (!s) throw new Error("Musterdepot noch nicht gestartet");
      const wl = new Set(s.watchlist);
      for (const w of a.add_watch ?? []) wl.add(w.trim().toUpperCase());
      for (const w of a.remove_watch ?? []) wl.delete(w.trim().toUpperCase());
      const upd: Record<string, unknown> = { watchlist: [...wl], updated_at: new Date().toISOString() };
      if (a.report_time) upd.report_time = a.report_time;
      if (a.enabled !== undefined) upd.enabled = a.enabled;
      const { error } = await db().from("trading_state").update(upd).eq("id", 1);
      if (error) throw error;
      return ok({ beobachtung: [...wl], bericht_um: a.report_time ?? s.report_time, aktiv: a.enabled ?? s.enabled });
    })),

    tool("paper_trades", "Gebuchte Papier-Trades mit Begründung.", { limit: z.number().int().min(1).max(100).default(20) }, safe(async (a) => {
      requireAdmin(ctx);
      const { data } = await db().from("trading_trades").select("at, symbol, name, side, qty, price_eur, fee_eur, reason, strategy_version").order("at", { ascending: false }).limit(a.limit);
      return ok(data ?? []);
    })),

    tool("paper_reports", "Frühere Abendberichte (Fazits).", { limit: z.number().int().min(1).max(30).default(5) }, safe(async (a) => {
      requireAdmin(ctx);
      const { data } = await db().from("trading_reports").select("day, equity_eur, benchmark_eur, summary, strategy_version").order("day", { ascending: false }).limit(a.limit);
      return ok(data ?? []);
    })),

    tool("paper_run_now", "Abendlauf sofort ausführen (z. B. zum Testen). Bucht zu den letzten Schlusskursen.", {}, safe(async () => {
      requireAdmin(ctx);
      const r = await runDay(ctx.config, quoteTool(), today(), true);
      return ok(r?.text ?? "Musterdepot ist nicht aktiv.");
    })),
  ];
}
