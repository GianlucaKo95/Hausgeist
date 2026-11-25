import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db.js";
import { logger } from "./log.js";
import type { AlpacaPaper, Bar } from "../adapters/alpaca.js";

const log = logger("intraday");

/* ───────────────────────── Regelwerk ─────────────────────────
 * Der Strategie-Agent schreibt Regeln in diesem Format; ausgeführt werden sie von fester
 * Engine-Logik – das Sprachmodell entscheidet nie live über einzelne Orders.
 */
const Price = z.enum(["open", "high", "low", "close", "volume"]);
export const Expr: z.ZodType<ExprT> = z.lazy(() => z.union([
  z.object({ ind: Price, mult: z.number().optional() }),
  z.object({ ind: z.enum(["sma", "ema"]), period: z.number().int().min(2).max(200), of: z.enum(["close", "volume"]).default("close"), mult: z.number().optional() }),
  z.object({ ind: z.literal("rsi"), period: z.number().int().min(2).max(50).default(14), mult: z.number().optional() }),
  z.object({ ind: z.literal("vwap"), mult: z.number().optional() }),
  z.object({ ind: z.enum(["highest", "lowest"]), period: z.number().int().min(2).max(200), mult: z.number().optional() }),
  z.object({ ind: z.literal("value"), value: z.number() }),
]));
export type ExprT =
  | { ind: "open" | "high" | "low" | "close" | "volume"; mult?: number }
  | { ind: "sma" | "ema"; period: number; of?: "close" | "volume"; mult?: number }
  | { ind: "rsi"; period?: number; mult?: number }
  | { ind: "vwap"; mult?: number }
  | { ind: "highest" | "lowest"; period: number; mult?: number }
  | { ind: "value"; value: number };

export const Condition = z.object({
  left: Expr,
  op: z.enum([">", "<", "cross_above", "cross_below"]),
  right: Expr,
});
export type ConditionT = z.infer<typeof Condition>;

export const Rules = z.object({
  symbols: z.array(z.string().regex(/^[A-Z.]{1,6}$/)).min(1).max(20),
  timeframe: z.union([z.literal(1), z.literal(5), z.literal(10)]).describe("Kerzenlänge in Minuten"),
  entry: z.array(Condition).min(1).max(8).describe("Alle Bedingungen müssen gelten (UND) – nur Long"),
  exit: z.object({
    stop_loss_pct: z.number().min(0.1).max(20),
    take_profit_pct: z.number().min(0.1).max(50).optional(),
    trailing_stop_pct: z.number().min(0.1).max(20).optional(),
    max_hold_min: z.number().int().min(1).max(390).optional(),
    conditions: z.array(Condition).max(8).default([]).describe("Verkaufen, sobald EINE davon gilt"),
  }),
  sizing: z.object({
    usd_per_trade: z.number().min(10).max(50_000),
    max_positions: z.number().int().min(1).max(10),
  }),
  risk: z.object({
    max_daily_loss_usd: z.number().min(10),
    max_trades_per_day: z.number().int().min(1).max(200).default(30),
    no_entry_first_min: z.number().int().min(0).max(120).default(5),
    flat_before_close_min: z.number().int().min(1).max(120).default(10),
    cooldown_min: z.number().int().min(0).max(240).default(15).describe("Nach Verkauf so lange kein neuer Einstieg im selben Wert"),
  }),
});
export type RulesT = z.infer<typeof Rules>;

/* ───────────────────────── Indikatoren (rein, testbar) ───────────────────────── */

/** 1-Minuten-Kerzen zu 5/10-Minuten-Kerzen bündeln (ab Börsenöffnung ausgerichtet). Unfertige Kerzen fallen weg. */
export function aggregate(bars: Bar[], minutes: number, nowMs: number): Bar[] {
  const done = bars.filter((b) => Date.parse(b.t) + 60_000 <= nowMs);
  if (minutes === 1) return done;
  const out: Bar[] = [];
  const bucketMs = minutes * 60_000;
  // Handelsbeginn 9:30 New York = :30 → Buckets relativ zur halben Stunde
  const keyOf = (t: number) => Math.floor((t - 30 * 60_000) / bucketMs);
  let cur: Bar | null = null, curKey = NaN, count = 0;
  const flush = () => { if (cur && Date.parse(cur.t) + bucketMs <= nowMs && count > 0) out.push(cur); };
  for (const b of done) {
    const t = Date.parse(b.t);
    const k = keyOf(t);
    if (k !== curKey) {
      flush();
      curKey = k; count = 0;
      cur = { t: new Date(k * bucketMs + 30 * 60_000).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c, v: 0 };
    }
    cur!.h = Math.max(cur!.h, b.h); cur!.l = Math.min(cur!.l, b.l); cur!.c = b.c; cur!.v += b.v; count++;
  }
  flush();
  return out;
}

function sma(xs: number[], n: number): number | null { if (xs.length < n) return null; let s = 0; for (let i = xs.length - n; i < xs.length; i++) s += xs[i]; return s / n; }
function ema(xs: number[], n: number): number | null {
  if (xs.length < n) return null;
  const k = 2 / (n + 1);
  let e = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < xs.length; i++) e = xs[i] * k + e * (1 - k);
  return e;
}
function rsi(xs: number[], n: number): number | null {
  if (xs.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) { const d = xs[i] - xs[i - 1]; if (d > 0) gain += d; else loss -= d; }
  gain /= n; loss /= n;
  for (let i = n + 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

/** Wert eines Ausdrucks an der Kerze `i` (Index in `bars`). `session` = Kerzen des heutigen Handelstags (für VWAP). */
export function value(e: ExprT, bars: Bar[], i: number, sessionStartMs: number): number | null {
  const upto = bars.slice(0, i + 1);
  const b = upto[upto.length - 1];
  if (!b) return null;
  let v: number | null;
  switch (e.ind) {
    case "open": case "high": case "low": case "close": case "volume": {
      const key = ({ open: "o", high: "h", low: "l", close: "c", volume: "v" } as const)[e.ind];
      v = b[key]; break;
    }
    case "sma": case "ema": {
      const xs = upto.map((x) => (e.of === "volume" ? x.v : x.c));
      v = e.ind === "sma" ? sma(xs, e.period) : ema(xs, e.period); break;
    }
    case "rsi": v = rsi(upto.map((x) => x.c), e.period ?? 14); break;
    case "vwap": {
      const sess = upto.filter((x) => Date.parse(x.t) >= sessionStartMs);
      const vol = sess.reduce((a, x) => a + x.v, 0);
      v = vol ? sess.reduce((a, x) => a + ((x.h + x.l + x.c) / 3) * x.v, 0) / vol : null; break;
    }
    case "highest": case "lowest": {
      // vorherige n Kerzen (ohne die aktuelle) – für Ausbrüche
      const prev = upto.slice(-e.period - 1, -1);
      v = prev.length < e.period ? null : e.ind === "highest" ? Math.max(...prev.map((x) => x.h)) : Math.min(...prev.map((x) => x.l));
      break;
    }
    case "value": v = e.value; break;
  }
  return v === null ? null : v * ("mult" in e && e.mult !== undefined ? e.mult : 1);
}

export function holds(c: ConditionT, bars: Bar[], sessionStartMs: number): boolean {
  const i = bars.length - 1;
  const l = value(c.left as ExprT, bars, i, sessionStartMs), r = value(c.right as ExprT, bars, i, sessionStartMs);
  if (l === null || r === null) return false;
  if (c.op === ">") return l > r;
  if (c.op === "<") return l < r;
  const lp = value(c.left as ExprT, bars, i - 1, sessionStartMs), rp = value(c.right as ExprT, bars, i - 1, sessionStartMs);
  if (lp === null || rp === null) return false;
  return c.op === "cross_above" ? lp <= rp && l > r : lp >= rp && l < r;
}

/** Für Berichte: Regel in Worten. */
export function describe(e: ExprT): string {
  const m = "mult" in e && e.mult !== undefined && e.mult !== 1 ? ` × ${e.mult}` : "";
  switch (e.ind) {
    case "sma": case "ema": return `${e.ind.toUpperCase()}${e.period}${e.of === "volume" ? "(Volumen)" : ""}${m}`;
    case "rsi": return `RSI${e.period ?? 14}${m}`;
    case "highest": return `Hoch der letzten ${e.period}${m}`;
    case "lowest": return `Tief der letzten ${e.period}${m}`;
    case "value": return String(e.value);
    default: return `${e.ind}${m}`;
  }
}

/* ───────────────────────── Engine ───────────────────────── */

interface Held { entryAt: number; entryPrice: number; peak: number }
interface DayState { day: string; trades: number; halted: string | null; cooldown: Record<string, number>; lastBar: Record<string, string>; held: Record<string, Held> }

export async function activeRules(): Promise<{ version: number; rules: RulesT } | null> {
  const { data } = await db().from("intraday_rules").select("version, rules").eq("status", "active").order("version", { ascending: false }).limit(1).maybeSingle();
  if (!data) return null;
  const parsed = Rules.safeParse(data.rules);
  if (!parsed.success) { log.error(`Regeln v${data.version} ungültig – Engine pausiert`); return null; }
  return { version: data.version as number, rules: parsed.data };
}

export class IntradayEngine {
  private state: DayState = { day: "", trades: 0, halted: null, cooldown: {}, lastBar: {}, held: {} };
  private busy = false;
  enabled = true;

  constructor(private alpaca: AlpacaPaper) {}

  status() { return { aktiv: this.enabled, tag: this.state.day, trades_heute: this.state.trades, gestoppt: this.state.halted, positionen: Object.keys(this.state.held) }; }

  private cache: Record<string, Bar[]> = {};
  private cacheFrom = 0;

  /** Kerzen-Puffer: einmal 4 Tage Vorlauf (Indikatoren, Wochenenden), danach nur noch die neuesten Minuten. */
  private async loadBars(symbols: string[], now: number): Promise<Record<string, Bar[]>> {
    const missing = symbols.filter((s) => !this.cache[s]);
    if (missing.length || now - this.cacheFrom > 6 * 3_600_000) {
      const full = await this.alpaca.bars(missing.length ? missing : symbols, new Date(now - 4 * 86_400_000).toISOString());
      for (const s of missing.length ? missing : symbols) this.cache[s] = full[s] ?? [];
      if (!missing.length) this.cacheFrom = now;
      if (!this.cacheFrom) this.cacheFrom = now;
    }
    const since = new Date(now - 5 * 60_000).toISOString();
    const fresh = await this.alpaca.bars(symbols, since);
    for (const s of symbols) {
      const map = new Map((this.cache[s] ?? []).map((b) => [b.t, b]));
      for (const b of fresh[s] ?? []) map.set(b.t, b); // letzte Minuten überschreiben (Kerzen werden nachgereicht)
      this.cache[s] = [...map.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t)).slice(-3000);
    }
    return Object.fromEntries(symbols.map((s) => [s, this.cache[s]]));
  }

  private async record(symbol: string, side: "buy" | "sell", reason: string, version: number, extra: { notional_usd?: number; qty?: number; price?: number; order_id?: string }) {
    await db().from("intraday_trades").insert({ symbol, side, reason, rule_version: version, ...extra });
    log.info(`${side === "buy" ? "Kauf" : "Verkauf"} ${symbol}: ${reason}`);
  }

  /** Einmal pro Minute aus dem Scheduler. */
  async tick(): Promise<void> {
    if (!this.enabled || this.busy || !this.alpaca.enabled) return;
    this.busy = true;
    try { await this.step(); } finally { this.busy = false; }
  }

  private async step(): Promise<void> {
    const clock = await this.alpaca.clock();
    if (!clock.is_open) return;
    const active = await activeRules();
    if (!active) return;
    const { rules, version } = active;
    const now = Date.parse(clock.timestamp);
    const day = clock.timestamp.slice(0, 10);
    if (this.state.day !== day) this.state = { day, trades: 0, halted: null, cooldown: {}, lastBar: {}, held: {} };

    const closeMs = Date.parse(clock.next_close);
    const openMs = closeMs - 390 * 60_000; // regulärer Handelstag 6,5 h (verkürzte Tage: konservativ)
    const minsToClose = (closeMs - now) / 60_000;
    const minsSinceOpen = (now - openMs) / 60_000;

    const positions = await this.alpaca.positions();
    const mine = new Map(positions.map((p) => [p.symbol, p]));

    // Tagesverlust-Grenze
    const acct = await this.alpaca.account();
    const dayPnl = Number(acct.equity) - Number(acct.last_equity);
    if (!this.state.halted && dayPnl <= -rules.risk.max_daily_loss_usd) {
      this.state.halted = `Tagesverlust ${dayPnl.toFixed(2)} $ – Grenze ${rules.risk.max_daily_loss_usd} $`;
      if (positions.length) { await this.alpaca.closeAll(); for (const p of positions) await this.record(p.symbol, "sell", `Notbremse: ${this.state.halted}`, version, { qty: Number(p.qty), price: Number(p.current_price) }); }
      return;
    }
    // Vor Börsenschluss alles glattstellen
    if (minsToClose <= rules.risk.flat_before_close_min) {
      for (const p of positions) {
        await this.alpaca.closePosition(p.symbol);
        await this.record(p.symbol, "sell", `Glattstellen ${rules.risk.flat_before_close_min} Min. vor Schluss`, version, { qty: Number(p.qty), price: Number(p.current_price) });
      }
      this.state.held = {};
      return;
    }

    const symbols = [...new Set([...rules.symbols, ...positions.map((p) => p.symbol)])];
    const raw = await this.loadBars(symbols, now);

    for (const sym of symbols) {
      const bars = aggregate(raw[sym] ?? [], rules.timeframe, now);
      if (bars.length < 3) continue;
      const last = bars[bars.length - 1];
      const pos = mine.get(sym);

      // ── Ausstieg (auch für Positionen, die schon da waren) ──
      if (pos) {
        const price = Number(pos.current_price) || last.c;
        const entry = Number(pos.avg_entry_price);
        const held = this.state.held[sym] ?? { entryAt: now, entryPrice: entry, peak: price };
        held.peak = Math.max(held.peak, price);
        this.state.held[sym] = held;
        const chg = (price / entry - 1) * 100;
        let why: string | null = null;
        if (chg <= -rules.exit.stop_loss_pct) why = `Stop-Loss ${chg.toFixed(2)} %`;
        else if (rules.exit.take_profit_pct && chg >= rules.exit.take_profit_pct) why = `Gewinnziel ${chg.toFixed(2)} %`;
        else if (rules.exit.trailing_stop_pct && (price / held.peak - 1) * 100 <= -rules.exit.trailing_stop_pct) why = `Nachlaufender Stop (Hoch ${held.peak.toFixed(2)})`;
        else if (rules.exit.max_hold_min && (now - held.entryAt) / 60_000 >= rules.exit.max_hold_min) why = `Haltedauer ${rules.exit.max_hold_min} Min. erreicht`;
        else if (this.state.lastBar[sym] !== last.t) {
          const hit = rules.exit.conditions.find((c) => holds(c, bars, openMs));
          if (hit) why = `Ausstiegsregel: ${describe(hit.left as ExprT)} ${hit.op} ${describe(hit.right as ExprT)}`;
        }
        if (why) {
          await this.alpaca.closePosition(sym);
          await this.record(sym, "sell", why, version, { qty: Number(pos.qty), price });
          delete this.state.held[sym];
          this.state.cooldown[sym] = now + rules.risk.cooldown_min * 60_000;
          this.state.trades++;
        }
        this.state.lastBar[sym] = last.t;
        continue;
      }

      // ── Einstieg: nur einmal pro neuer Kerze prüfen ──
      if (this.state.lastBar[sym] === last.t) continue;
      this.state.lastBar[sym] = last.t;
      if (!rules.symbols.includes(sym) || this.state.halted) continue;
      if (minsSinceOpen < rules.risk.no_entry_first_min) continue;
      if (this.state.trades >= rules.risk.max_trades_per_day) continue;
      if ((this.state.cooldown[sym] ?? 0) > now) continue;
      if (mine.size >= rules.sizing.max_positions) continue;
      if (!rules.entry.every((c) => holds(c, bars, openMs))) continue;
      if (Number(acct.buying_power) < rules.sizing.usd_per_trade) continue;

      const reason = `Einstieg (${rules.timeframe}-Min.-Kerze ${new Date(last.t).toLocaleTimeString("de-DE", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" })} NY): ${rules.entry.map((c) => `${describe(c.left as ExprT)} ${c.op} ${describe(c.right as ExprT)}`).join(" UND ")}`;
      const order = await this.alpaca.buyNotional(sym, rules.sizing.usd_per_trade, `hg-${randomUUID().slice(0, 18)}`);
      await this.record(sym, "buy", reason, version, { notional_usd: rules.sizing.usd_per_trade, price: last.c, order_id: order.id });
      this.state.held[sym] = { entryAt: now, entryPrice: last.c, peak: last.c };
      mine.set(sym, { symbol: sym } as never);
      this.state.trades++;
    }
  }
}

/* ───────────────────────── Backtest ─────────────────────────
 * Dieselben Regeln über vergangene Kerzen: Einstieg zum Schluss der Signalkerze,
 * Ausstieg bei Stop/Ziel/Trailing/Regel/Haltedauer/Börsenschluss, je 0,05 % Schlupf.
 */
export interface BacktestResult { trades: number; wins: number; pnl_usd: number; pnl_pct_of_capital: number; max_drawdown_usd: number; per_symbol: Record<string, { trades: number; pnl_usd: number }>; examples: string[] }

export function backtest(rules: RulesT, bars1m: Record<string, Bar[]>): BacktestResult {
  const SLIP = 0.0005;
  const res: BacktestResult = { trades: 0, wins: 0, pnl_usd: 0, pnl_pct_of_capital: 0, max_drawdown_usd: 0, per_symbol: {}, examples: [] };
  const events: { t: number; pnl: number }[] = [];
  const dayOf = (t: string) => new Date(t).toLocaleDateString("sv-SE", { timeZone: "America/New_York" });
  const nyMinutes = (t: string) => { const [h, m] = new Date(t).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }).split(":").map(Number); return h * 60 + m; };

  for (const sym of rules.symbols) {
    const regular = (bars1m[sym] ?? []).filter((b) => { const m = nyMinutes(b.t); return m >= 570 && m < 960; });
    const all = aggregate(regular, rules.timeframe, Date.now());
    let pos: { entry: number; at: number; peak: number; qty: number; t: string } | null = null;
    let cooldownUntil = 0, dayTrades = 0, curDay = "", dayPnl = 0;
    for (let i = 2; i < all.length; i++) {
      const b = all[i];
      const t = Date.parse(b.t), d = dayOf(b.t);
      if (d !== curDay) { curDay = d; dayTrades = 0; dayPnl = 0; }
      const sessionStart = Date.parse(all.find((x) => dayOf(x.t) === d)!.t);
      const window = all.slice(Math.max(0, i - 400), i + 1);
      const minute = nyMinutes(b.t) + rules.timeframe;
      if (pos) {
        pos.peak = Math.max(pos.peak, b.h);
        const chgLow = (b.l / pos.entry - 1) * 100, chgHigh = (b.h / pos.entry - 1) * 100;
        let exit: number | null = null, why = "";
        if (chgLow <= -rules.exit.stop_loss_pct) { exit = pos.entry * (1 - rules.exit.stop_loss_pct / 100); why = "Stop"; }
        else if (rules.exit.take_profit_pct && chgHigh >= rules.exit.take_profit_pct) { exit = pos.entry * (1 + rules.exit.take_profit_pct / 100); why = "Ziel"; }
        else if (rules.exit.trailing_stop_pct && (b.c / pos.peak - 1) * 100 <= -rules.exit.trailing_stop_pct) { exit = b.c; why = "Trailing"; }
        else if (rules.exit.max_hold_min && (t - pos.at) / 60_000 >= rules.exit.max_hold_min) { exit = b.c; why = "Haltedauer"; }
        else if (rules.exit.conditions.some((c) => holds(c, window, sessionStart))) { exit = b.c; why = "Regel"; }
        else if (minute >= 960 - rules.risk.flat_before_close_min || dayOf(all[i + 1]?.t ?? b.t) !== d || i === all.length - 1) { exit = b.c; why = "Schluss"; }
        if (exit !== null) {
          const pnl = pos.qty * (exit * (1 - SLIP) - pos.entry);
          res.trades++; if (pnl > 0) res.wins++; res.pnl_usd += pnl; dayPnl += pnl;
          (res.per_symbol[sym] ??= { trades: 0, pnl_usd: 0 }).trades++; res.per_symbol[sym].pnl_usd += pnl;
          events.push({ t, pnl });
          if (res.examples.length < 8) res.examples.push(`${sym} ${pos.t.slice(5, 16)} → ${why}: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} $`);
          pos = null; cooldownUntil = t + rules.risk.cooldown_min * 60_000;
        }
        continue;
      }
      const sinceOpen = nyMinutes(b.t) - 570;
      if (sinceOpen < rules.risk.no_entry_first_min || minute >= 960 - rules.risk.flat_before_close_min) continue;
      if (t < cooldownUntil || dayTrades >= rules.risk.max_trades_per_day || dayPnl <= -rules.risk.max_daily_loss_usd) continue;
      if (rules.entry.every((c) => holds(c, window, sessionStart))) {
        const entry = b.c * (1 + SLIP);
        pos = { entry, at: t, peak: b.c, qty: rules.sizing.usd_per_trade / entry, t: b.t };
        dayTrades++;
      }
    }
  }
  // Drawdown über die zeitlich sortierten Ergebnisse
  let eq = 0, peak = 0;
  for (const e of events.sort((a, b) => a.t - b.t)) { eq += e.pnl; peak = Math.max(peak, eq); res.max_drawdown_usd = Math.max(res.max_drawdown_usd, peak - eq); }
  const capital = rules.sizing.usd_per_trade * rules.sizing.max_positions;
  res.pnl_usd = Math.round(res.pnl_usd * 100) / 100;
  res.max_drawdown_usd = Math.round(res.max_drawdown_usd * 100) / 100;
  res.pnl_pct_of_capital = Math.round((res.pnl_usd / capital) * 10_000) / 100;
  for (const v of Object.values(res.per_symbol)) v.pnl_usd = Math.round(v.pnl_usd * 100) / 100;
  return res;
}
