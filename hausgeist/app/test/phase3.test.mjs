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

import { sourceKey } from "../dist/core/calendar-insights.js";
import { inRange, parseEvents } from "../dist/adapters/calendar.js";

test("Kalender: Dubletten-Schlüssel und Zeitraum", () => {
  assert.equal(sourceKey("2026-11-24 Papiermüll", "u1"), sourceKey(" 2026-11-24 papiermüll ", "u1"));
  assert.notEqual(sourceKey("2026-11-24 papiermüll", "u1"), sourceKey("2026-11-24 papiermüll", "u2"));
  const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Papiertonne\r\nDTSTART;VALUE=DATE:20261124\r\nDTEND;VALUE=DATE:20261125\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Restmüll\r\nDTSTART;VALUE=DATE:20261208\r\nEND:VEVENT\r\nEND:VCALENDAR";
  const evs = parseEvents(ics, "Abfall").filter((e) => inRange(e, "2026-11-22T00:00:00Z", "2026-11-30T00:00:00Z"));
  assert.deepEqual(evs.map((e) => e.title), ["Papiertonne"]);
});

import { canApproveAction } from "../dist/core/checks.js";
import { viewUploadTool, reverseImageSearchTool, bookingTool } from "../dist/tools/media.js";

test("Buchungen: Limit wie bei Bestellungen", () => {
  const adult = { id: "b", name: "A", role: "adult", approval_limit_cents: 50000, ha_user_id: null, notify_service: "n" };
  assert.equal(canApproveAction(adult, { kind: "booking", amount_cents: 40000 }).allowed, true);
  assert.equal(canApproveAction(adult, { kind: "booking", amount_cents: 90000 }).allowed, false);
  const ctx = { config: { serpapi_key: "" }, user: adult };
  assert.deepEqual([viewUploadTool(ctx), reverseImageSearchTool(ctx), bookingTool(ctx)].map((t) => t.name),
    ["view_upload", "reverse_image_search", "request_booking"]);
});

import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { normalizeP8, ApnsClient } from "../dist/adapters/apns.js";

test("APNs: Schlüssel einlesen und Token signieren", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  // Wie aus einem einzeiligen HA-Feld: Umbrüche als \n oder Leerzeichen
  for (const raw of [pem, pem.replace(/\n/g, "\\n"), pem.replace(/\n/g, " ")]) {
    assert.match(normalizeP8(raw), /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PRIVATE KEY-----\n$/);
  }
  const client = new ApnsClient({ apns_key_id: "ABC123DEFG", apns_team_id: "TEAM123456", apns_key: pem.replace(/\n/g, " "), apns_bundle_id: "de.hausgeist.koeven" });
  assert.equal(client.enabled, true);
  const jwt = client.token();
  const [h, c, s] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(h, "base64url")).kid, "ABC123DEFG");
  assert.equal(JSON.parse(Buffer.from(c, "base64url")).iss, "TEAM123456");
  const ok = verify("sha256", Buffer.from(`${h}.${c}`), { key: createPublicKey(privateKey), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  assert.equal(ok, true);
});
