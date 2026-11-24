import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate } from "../dist/core/paper-trading.js";

const px = { "SAP.DE": { price: 200, priceEur: 200, currency: "EUR", name: "SAP" }, MSFT: { price: 400, priceEur: 370, currency: "USD", name: "Microsoft" } };
const price = (s) => px[s];

test("Papier-Trades: Gebühren, Spread, nie mehr als Bargeld", () => {
  const pos = new Map();
  const r = simulate(1000, pos, [{ symbol: "SAP.DE", side: "buy", amount_eur: 501 }, { symbol: "MSFT", side: "buy", amount_eur: 5000 }], price);
  assert.equal(r.done.length, 2);
  assert.ok(r.cash >= 0 && r.cash < 1);
  assert.equal(r.done[0].fee_eur, 1);
  assert.equal(pos.get("SAP.DE").qty, 2.4975); // (501-1)/(200*1.001) abgerundet
});

test("Erst verkaufen, dann kaufen; nicht mehr verkaufen als vorhanden; Unbekanntes überspringen", () => {
  const pos = new Map([["SAP.DE", { symbol: "SAP.DE", name: "SAP", currency: "EUR", qty: 5, avg_cost_eur: 150 }]]);
  const r = simulate(0, pos, [{ symbol: "MSFT", side: "buy", amount_eur: 500 }, { symbol: "SAP.DE", side: "sell", qty: 99 }, { symbol: "XYZ", side: "buy", amount_eur: 100 }], price);
  assert.equal(r.done[0].side, "sell");
  assert.equal(r.done[0].qty, 5);
  assert.ok(!pos.has("SAP.DE"));
  assert.equal(r.done[1].symbol, "MSFT");
  assert.match(r.skipped.join(), /XYZ/);
  assert.ok(r.cash >= 0);
});
