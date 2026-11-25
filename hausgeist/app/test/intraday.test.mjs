import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, holds, Rules, backtest } from "../dist/core/intraday.js";
import { realized } from "../dist/core/intraday-review.js";

// 9:30 NY = 14:30 UTC (Winterzeit)
const mk = (min, c, v = 100) => ({ t: new Date(Date.UTC(2026, 10, 24, 14, 30 + min)).toISOString(), o: c, h: c + 0.1, l: c - 0.1, c, v });

test("1-Min.-Kerzen zu 5-Min.-Kerzen ab Börsenöffnung, unfertige fallen weg", () => {
  const bars = Array.from({ length: 12 }, (_, i) => mk(i, 100 + i));
  const now = Date.parse(bars[11].t) + 60_000;
  const five = aggregate(bars, 5, now);
  assert.equal(five.length, 2);
  assert.equal(five[0].o, 100); assert.equal(five[0].c, 104); assert.equal(five[0].v, 500);
  assert.equal(new Date(five[1].t).getUTCMinutes(), 35);
});

test("Kreuzen von oben/unten und Vergleiche", () => {
  const bars = [...Array.from({ length: 20 }, (_, i) => mk(i, 100)), mk(20, 101)];
  const cross = { left: { ind: "close" }, op: "cross_above", right: { ind: "sma", period: 10, of: "close" } };
  assert.equal(holds(cross, bars, 0), true);
  assert.equal(holds({ left: { ind: "close" }, op: ">", right: { ind: "highest", period: 5 } }, bars, 0), true);
  assert.equal(holds({ left: { ind: "rsi", period: 14 }, op: "<", right: { ind: "value", value: 30 } }, bars, 0), false);
});

test("Regel-Schema verlangt Stop-Loss und Tagesgrenze", () => {
  assert.equal(Rules.safeParse({ symbols: ["AAPL"], timeframe: 5, entry: [], exit: {}, sizing: {}, risk: {} }).success, false);
  const ok = Rules.parse({ symbols: ["AAPL"], timeframe: 5, entry: [{ left: { ind: "close" }, op: ">", right: { ind: "vwap" } }], exit: { stop_loss_pct: 1 }, sizing: { usd_per_trade: 1000, max_positions: 2 }, risk: { max_daily_loss_usd: 100 } });
  assert.equal(ok.risk.flat_before_close_min, 10);
});

test("Backtest: Ausbruch mit Ziel und Stop", () => {
  const r = Rules.parse({ symbols: ["X"], timeframe: 1, entry: [{ left: { ind: "close" }, op: ">", right: { ind: "highest", period: 3 } }], exit: { stop_loss_pct: 1, take_profit_pct: 1 }, sizing: { usd_per_trade: 1000, max_positions: 1 }, risk: { max_daily_loss_usd: 500, no_entry_first_min: 0, cooldown_min: 0 } });
  const prices = [100, 100, 100, 100, 100.5, 100.8, 101.2, 101.8, 102, 102, 102];
  const res = backtest(r, { X: prices.map((c, i) => mk(i, c)) });
  assert.ok(res.trades >= 1);
  assert.ok(res.pnl_usd > 0);
});

test("Realisierte Gewinne FIFO", () => {
  const r = realized([{ symbol: "A", side: "buy", qty: "2", price: "10" }, { symbol: "A", side: "buy", qty: "2", price: "12" }, { symbol: "A", side: "sell", qty: "3", price: "13" }]);
  assert.equal(r.total, 2 * 3 + 1 * 1);
});
