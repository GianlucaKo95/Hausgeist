import { test } from "node:test";
import assert from "node:assert/strict";
import { alertMet, nextRun, addDays, berlinNow } from "../dist/core/scheduler.js";
import { DocumentInfo, isSupportedMime } from "../dist/agents/extract.js";

test("Alarmbedingungen", () => {
  assert.equal(alertMet("below", "5", "2.1"), true);
  assert.equal(alertMet("below", "5", "120"), false);
  assert.equal(alertMet("above", "95", "97"), true);
  assert.equal(alertMet("above", "95", "unavailable"), false);
  assert.equal(alertMet("equals", "off", "OFF"), true);
  assert.equal(alertMet("unavailable", null, "unavailable"), true);
  assert.equal(alertMet("unavailable", null, undefined), true);
  assert.equal(alertMet("unavailable", null, "on"), false);
  assert.equal(alertMet("below", "5", "abc"), false);
});

test("Wiederholungen", () => {
  const fri = new Date("2026-11-27T13:00:00");     // Freitag
  assert.equal(nextRun(fri, "weekdays").getDay(), 1); // → Montag
  assert.equal(nextRun(fri, "daily").getDate(), 28);
  assert.equal(nextRun(new Date("2026-01-31T08:00:00"), "monthly").getMonth(), 2); // JS-Verhalten: 31.01. + 1 Monat → 03.03.
  assert.equal(nextRun(fri, "none"), null);
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
});

test("Berliner Zeit", () => {
  const n = berlinNow(new Date("2026-11-22T23:30:00Z"));
  assert.equal(n.date, "2026-11-23");
  assert.equal(n.time, "00:30");
  assert.equal(n.weekday, 1);
});

test("Dokumentschema und Dateitypen", () => {
  assert.equal(isSupportedMime("image/jpeg"), true);
  assert.equal(isSupportedMime("image/heic"), false);
  const r = DocumentInfo.safeParse({ document_type: "contract", needs_payment: false, issuer: "X", recipient_name: null,
    invoice_number: null, invoice_date: null, due_date: null, amount_cents: 0, currency: "EUR", iban: null, bic: null,
    reference: null, category: null, suspicious: null, contract_title: "Strom", contract_monthly_cents: 8900,
    contract_start: "2026-01-01", contract_end: "2027-12-31", notice_period_days: 30, auto_renew_months: 12,
    appointment_title: null, appointment_start: null, appointment_end: null, appointment_location: null, summary: "Stromvertrag" });
  assert.equal(r.success, true);
});
