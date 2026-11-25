import { db } from "./db.js";
import { logger } from "./log.js";
import type { Config } from "./config.js";
import { runMiniAgent, parseJsonObject } from "./mini-agent.js";

const log = logger("musterdepot");

/**
 * Musterdepot für den Strategie-Agenten. Es gibt KEINE Verbindung zu einem Broker:
 * Trades werden nur auf dem Papier zum Schlusskurs gebucht (mit Gebühren und Spread),
 * damit sich die Strategie über Monate ehrlich mit einem ETF vergleichen lässt.
 */

export const FEE_FLAT_EUR = 1;
export const SPREAD = 0.001; // 0,1 % Kursnachteil je Order

export interface Quote { symbol: string; name: string | null; currency: string; close: number; day: string; closes: { day: string; close: number }[] }

export interface TradingState {
  enabled: boolean; start_cash_eur: number; cash_eur: number; started_at: string; benchmark: string; benchmark_units: number;
  report_time: string; strategy: string; strategy_version: number; watchlist: string[];
}
export interface Position { symbol: string; name: string | null; currency: string; qty: number; avg_cost_eur: number }
export interface PlannedTrade { symbol: string; side: "buy" | "sell"; amount_eur?: number; qty?: number; reason?: string }

const num = (v: unknown) => Number(v ?? 0);
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** Tageskurse von Yahoo Finance (ohne Schlüssel). Symbole wie „SAP.DE“, „AAPL“, „EUNL.DE“. */
export async function fetchQuote(symbol: string): Promise<Quote> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 Hausgeist" } });
  if (!res.ok) throw new Error(`Kurs für ${symbol} nicht abrufbar (${res.status})`);
  const j = (await res.json()) as { chart?: { result?: { meta: Record<string, unknown>; timestamp?: number[]; indicators: { quote: { close: (number | null)[] }[] } }[]; error?: { description?: string } } };
  const r = j.chart?.result?.[0];
  if (!r?.timestamp?.length) throw new Error(`Unbekanntes Symbol ${symbol}${j.chart?.error?.description ? ` (${j.chart.error.description})` : ""}`);
  const closes: { day: string; close: number }[] = [];
  r.timestamp.forEach((t, i) => {
    const c = r.indicators.quote[0]?.close?.[i];
    if (typeof c === "number") closes.push({ day: new Date(t * 1000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }), close: c });
  });
  if (!closes.length) throw new Error(`Keine Kurse für ${symbol}`);
  let currency = String(r.meta.currency ?? "EUR");
  let factor = 1;
  if (currency === "GBp") { currency = "GBP"; factor = 0.01; } // Pence → Pfund
  const fixed = closes.map((c) => ({ ...c, close: c.close * factor }));
  const last = fixed[fixed.length - 1];
  return { symbol, name: (r.meta.longName ?? r.meta.shortName ?? null) as string | null, currency, close: last.close, day: last.day, closes: fixed };
}

const fxCache = new Map<string, { at: number; rate: number }>();
/** Umrechnungskurs: 1 Einheit Fremdwährung in Euro. */
export async function toEurRate(currency: string): Promise<number> {
  if (currency === "EUR") return 1;
  const hit = fxCache.get(currency);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.rate;
  const q = await fetchQuote(`EUR${currency}=X`); // z. B. EURUSD=X = Dollar je Euro
  const rate = 1 / q.close;
  fxCache.set(currency, { at: Date.now(), rate });
  return rate;
}

/**
 * Bucht geplante Papier-Trades: nur Long, kein Hebel, nie mehr ausgeben als Bargeld da ist,
 * nie mehr verkaufen als im Depot liegt. Reine Rechnung – gut testbar.
 */
export function simulate(
  cash: number, positions: Map<string, Position>, plan: PlannedTrade[],
  priceEur: (symbol: string) => { price: number; priceEur: number; currency: string; name: string | null } | undefined,
): { cash: number; done: { symbol: string; name: string | null; side: "buy" | "sell"; qty: number; price: number; currency: string; price_eur: number; fee_eur: number; reason: string }[]; skipped: string[] } {
  const done: ReturnType<typeof simulate>["done"] = [];
  const skipped: string[] = [];
  // Erst verkaufen, dann kaufen – so steht der Erlös für Käufe bereit
  const ordered = [...plan].sort((a, b) => (a.side === b.side ? 0 : a.side === "sell" ? -1 : 1));
  for (const t of ordered) {
    const p = priceEur(t.symbol);
    if (!p) { skipped.push(`${t.symbol}: kein Kurs`); continue; }
    if (t.side === "buy") {
      const fill = p.priceEur * (1 + SPREAD);
      let qty = t.qty ?? (t.amount_eur ? (t.amount_eur - FEE_FLAT_EUR) / fill : 0);
      if (qty * fill + FEE_FLAT_EUR > cash) qty = (cash - FEE_FLAT_EUR) / fill;
      qty = Math.floor(qty * 10_000) / 10_000;
      if (qty <= 0 || qty * fill < 25) { skipped.push(`${t.symbol}: zu wenig Bargeld oder Betrag unter 25 €`); continue; }
      cash -= qty * fill + FEE_FLAT_EUR;
      const pos = positions.get(t.symbol) ?? { symbol: t.symbol, name: p.name, currency: p.currency, qty: 0, avg_cost_eur: 0 };
      const cost = pos.qty * pos.avg_cost_eur + qty * fill + FEE_FLAT_EUR;
      pos.qty = round(pos.qty + qty, 4);
      pos.avg_cost_eur = cost / pos.qty;
      positions.set(t.symbol, pos);
      done.push({ symbol: t.symbol, name: p.name, side: "buy", qty, price: p.price, currency: p.currency, price_eur: round(fill, 4), fee_eur: FEE_FLAT_EUR, reason: t.reason ?? "" });
    } else {
      const pos = positions.get(t.symbol);
      if (!pos || pos.qty <= 0) { skipped.push(`${t.symbol}: nicht im Depot`); continue; }
      const fill = p.priceEur * (1 - SPREAD);
      let qty = t.qty ?? (t.amount_eur ? t.amount_eur / fill : pos.qty);
      qty = Math.min(Math.floor(qty * 10_000) / 10_000, pos.qty);
      if (qty <= 0) { skipped.push(`${t.symbol}: Menge 0`); continue; }
      cash += qty * fill - FEE_FLAT_EUR;
      pos.qty = round(pos.qty - qty, 4);
      if (pos.qty <= 0.00005) positions.delete(t.symbol); else positions.set(t.symbol, pos);
      done.push({ symbol: t.symbol, name: pos.name, side: "sell", qty, price: p.price, currency: p.currency, price_eur: round(fill, 4), fee_eur: FEE_FLAT_EUR, reason: t.reason ?? "" });
    }
  }
  return { cash: round(cash, 2), done, skipped };
}

export async function loadState(): Promise<TradingState | null> {
  const { data } = await db().from("trading_state").select("*").eq("id", 1).maybeSingle();
  if (!data) return null;
  return { ...data, start_cash_eur: num(data.start_cash_eur), cash_eur: num(data.cash_eur), benchmark_units: num(data.benchmark_units) } as TradingState;
}

export async function loadPositions(): Promise<Map<string, Position>> {
  const { data } = await db().from("trading_positions").select("symbol, name, currency, qty, avg_cost_eur");
  return new Map((data ?? []).map((p) => [p.symbol as string, { ...p, qty: num(p.qty), avg_cost_eur: num(p.avg_cost_eur) } as Position]));
}

/** Depot neu starten (alles verkauft, Startkapital gesetzt, Vergleichs-ETF zum heutigen Kurs „gekauft“). */
export async function startPortfolio(startCash: number, strategy: string, benchmark = "EUNL.DE", watchlist: string[] = []): Promise<TradingState> {
  const b = await fetchQuote(benchmark);
  const units = startCash / (b.close * (await toEurRate(b.currency)));
  await db().from("trading_positions").delete().neq("symbol", "");
  const prev = await loadState();
  const version = (prev?.strategy_version ?? 0) + 1;
  const row = {
    id: 1, enabled: true, start_cash_eur: startCash, cash_eur: startCash, started_at: new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }),
    benchmark, benchmark_units: units, report_time: prev?.report_time ?? "22:15", strategy, strategy_version: version,
    watchlist: watchlist.length ? watchlist : prev?.watchlist ?? [], updated_at: new Date().toISOString(),
  };
  const { error } = await db().from("trading_state").upsert(row);
  if (error) throw error;
  await db().from("trading_strategy_history").upsert({ version, strategy, note: "Start des Musterdepots" });
  return (await loadState())!;
}

export async function setStrategy(strategy: string, note?: string): Promise<number> {
  const s = await loadState();
  if (!s) throw new Error("Musterdepot noch nicht gestartet");
  const version = s.strategy_version + 1;
  await db().from("trading_state").update({ strategy, strategy_version: version, updated_at: new Date().toISOString() }).eq("id", 1);
  await db().from("trading_strategy_history").upsert({ version, strategy, note: note ?? null });
  return version;
}

/** Aktueller Stand mit Bewertung zum letzten Schlusskurs. */
export async function valuation() {
  const s = await loadState();
  if (!s) throw new Error("Musterdepot noch nicht gestartet – „Starte ein Musterdepot mit 10.000 €“");
  const positions = await loadPositions();
  const rows = [];
  let invested = 0;
  for (const p of positions.values()) {
    try {
      const q = await fetchQuote(p.symbol);
      const value = p.qty * q.close * (await toEurRate(q.currency));
      invested += value;
      rows.push({ symbol: p.symbol, name: p.name, qty: p.qty, kurs: round(q.close, 2), waehrung: q.currency, wert_eur: round(value), einstand_eur: round(p.qty * p.avg_cost_eur), gv_prozent: round((value / (p.qty * p.avg_cost_eur) - 1) * 100, 1), stand: q.day });
    } catch (e) { rows.push({ symbol: p.symbol, name: p.name, qty: p.qty, fehler: (e as Error).message }); }
  }
  const b = await fetchQuote(s.benchmark);
  const benchmark = s.benchmark_units * b.close * (await toEurRate(b.currency));
  const equity = s.cash_eur + invested;
  return {
    state: s, positions: rows, cash: round(s.cash_eur), equity: round(equity), benchmark: round(benchmark), benchmarkDay: b.day,
    perf: round((equity / s.start_cash_eur - 1) * 100, 2), benchPerf: round((benchmark / s.start_cash_eur - 1) * 100, 2),
  };
}

const SYSTEM = `Du bist der Strategie-Agent für ein MUSTERDEPOT (nur Papier, kein echtes Geld, kein Broker).
Du hältst dich an die Strategie des Nutzers. Long only, kein Hebel, keine Derivate, keine Leerverkäufe.
Symbole im Yahoo-Finance-Format (deutsche Börse mit .DE, z. B. SAP.DE; US ohne Endung, z. B. MSFT).
Prüfe Kurse mit get_quote, recherchiere bei Bedarf kurz im Web (Nachrichten, Quartalszahlen). Erfinde keine Kurse oder Nachrichten.
Gebühren pro Order: 1 € plus 0,1 % Spread – handle nicht unnötig oft. Kein Trade ist eine gültige Entscheidung.
Antworte am Ende NUR mit JSON:
{"trades":[{"symbol":"…","side":"buy|sell","amount_eur":1000,"reason":"…"}],
 "fazit":"Tagesfazit auf Deutsch, 4–8 Sätze: was lief am Markt, wie steht das Depot vs. Vergleichs-ETF, warum diese Trades (oder keine), was du beobachtest. Ehrlich, auch wenn die Strategie hinterherhinkt."}
Für Verkäufe statt amount_eur auch "qty" oder gar nichts (= alles verkaufen).`;

/**
 * Abendlauf: Agent schlägt nach seiner Strategie Trades vor, sie werden zum Schlusskurs
 * auf dem Papier gebucht, Fazit wird gespeichert. Gibt den Bericht zurück (oder null an Feiertagen).
 */
export async function runDay(config: Config, getQuoteTool: unknown, today: string, force = false): Promise<{ text: string; day: string } | null> {
  const s = await loadState();
  if (!s || !s.enabled) return null;
  const bench = await fetchQuote(s.benchmark);
  if (bench.day !== today && !force) { log.info(`Kein Handelstag (${today}) – kein Bericht`); return null; }
  const { data: existing } = await db().from("trading_reports").select("day").eq("day", today).maybeSingle();
  if (existing && !force) return null;

  const before = await valuation();
  const { data: lastReports } = await db().from("trading_reports").select("day, summary, equity_eur").order("day", { ascending: false }).limit(3);
  const { data: recentTrades } = await db().from("trading_trades").select("at, symbol, side, qty, price_eur, reason").order("at", { ascending: false }).limit(15);

  const prompt = `Heute: ${today}. Strategie (Version ${s.strategy_version}):
"""${s.strategy}"""

Depot: Bargeld ${before.cash} €, Gesamtwert ${before.equity} € (Start ${s.start_cash_eur} € am ${s.started_at}, ${before.perf} %).
Vergleich ${s.benchmark}: ${before.benchmark} € (${before.benchPerf} %).
Positionen: ${JSON.stringify(before.positions)}
Beobachtungsliste: ${s.watchlist.join(", ") || "(leer – such dir passende Werte zur Strategie)"}
Letzte Trades: ${JSON.stringify(recentTrades ?? [])}
Letzte Fazits: ${JSON.stringify((lastReports ?? []).map((r) => ({ tag: r.day, wert: r.equity_eur, fazit: String(r.summary).slice(0, 400) })))}`;

  const raw = await runMiniAgent(config, { system: SYSTEM, prompt, web: true, tools: [getQuoteTool as never], maxTurns: 25, label: "musterdepot" });
  const parsed = parseJsonObject<{ trades?: PlannedTrade[]; fazit?: string }>(raw);
  if (!parsed?.fazit) throw new Error("Strategie-Agent hat kein auswertbares Ergebnis geliefert");

  const plan = (parsed.trades ?? []).filter((t) => t && typeof t.symbol === "string" && (t.side === "buy" || t.side === "sell")).slice(0, 10);
  const prices = new Map<string, { price: number; priceEur: number; currency: string; name: string | null }>();
  for (const t of plan) {
    try {
      const q = await fetchQuote(t.symbol);
      if (q.day !== today && !force) continue; // nur zu heutigen Schlusskursen buchen
      prices.set(t.symbol, { price: q.close, priceEur: q.close * (await toEurRate(q.currency)), currency: q.currency, name: q.name });
    } catch { /* übersprungen */ }
  }
  const positions = await loadPositions();
  const sim = simulate(s.cash_eur, positions, plan, (sym) => prices.get(sym));

  // Buchen
  if (sim.done.length) {
    await db().from("trading_trades").insert(sim.done.map((d) => ({ ...d, strategy_version: s.strategy_version })));
    await db().from("trading_positions").delete().neq("symbol", "");
    if (positions.size) await db().from("trading_positions").insert([...positions.values()].map((p) => ({ symbol: p.symbol, name: p.name, currency: p.currency, qty: p.qty, avg_cost_eur: p.avg_cost_eur })));
  }
  await db().from("trading_state").update({ cash_eur: sim.cash, updated_at: new Date().toISOString() }).eq("id", 1);

  const after = await valuation();
  const tradeLines = sim.done.map((d) => `${d.side === "buy" ? "Kauf" : "Verkauf"} ${d.qty} × ${d.name ?? d.symbol} zu ${round(d.price_eur, 2)} € – ${d.reason}`);
  const diff = round(after.perf - after.benchPerf, 2);
  const text = [
    `Depot ${after.equity.toLocaleString("de-DE")} € (${after.perf >= 0 ? "+" : ""}${after.perf} %) · ${s.benchmark} ${after.benchPerf >= 0 ? "+" : ""}${after.benchPerf} % · ${diff >= 0 ? "vorn" : "hinten"} um ${Math.abs(diff)} Punkte`,
    tradeLines.length ? `Trades:\n${tradeLines.join("\n")}` : "Keine Trades heute.",
    sim.skipped.length ? `Nicht ausgeführt: ${sim.skipped.join("; ")}` : "",
    parsed.fazit,
    "(Musterdepot – kein echtes Geld, keine Anlageberatung.)",
  ].filter(Boolean).join("\n\n");

  await db().from("trading_reports").upsert({
    day: today, equity_eur: after.equity, cash_eur: after.cash, benchmark_eur: after.benchmark,
    summary: text, trades: sim.done, strategy_version: s.strategy_version,
  });
  return { text, day: today };
}
