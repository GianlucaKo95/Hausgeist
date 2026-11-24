import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidIban, normalizeIban, payeeStatus, canApprove, approversFor, duplicateKey, suggestAccount,
} from "../dist/core/checks.js";

const admin = { id: "a", name: "Admin", role: "admin", approval_limit_cents: 0, ha_user_id: "ha-a", notify_service: "mobile_app_a" };
const adult = { id: "b", name: "Erwachsen", role: "adult", approval_limit_cents: 50000, ha_user_id: "ha-b", notify_service: "mobile_app_b" };
const child = { id: "c", name: "Kind", role: "child", approval_limit_cents: 0, ha_user_id: "ha-c", notify_service: "mobile_app_c" };

test("IBAN-Prüfsumme", () => {
  assert.equal(isValidIban("DE89 3704 0044 0532 0130 00"), true);
  assert.equal(isValidIban("DE89370400440532013001"), false);
  assert.equal(isValidIban("kein iban"), false);
  assert.equal(normalizeIban("de89 3704"), "DE893704");
});

test("Empfängerstatus", () => {
  assert.equal(payeeStatus("DE89370400440532013000", ["DE89 3704 0044 0532 0130 00"], true), "known");
  assert.equal(payeeStatus("DE89370400440532013000", ["DE02120300000000202051"], true), "iban_changed");
  assert.equal(payeeStatus("DE89370400440532013000", [], false), "new");
});

test("Freigaberechte", () => {
  const known = { amount_cents: 50000, payee_status: "known" };
  assert.equal(canApprove(adult, known).allowed, true);
  assert.equal(canApprove(adult, { ...known, amount_cents: 50001 }).allowed, false);
  assert.equal(canApprove(admin, { ...known, amount_cents: 999999 }).allowed, true);
  assert.equal(canApprove(child, { ...known, amount_cents: 1 }).allowed, false);
  assert.equal(canApprove(adult, { amount_cents: 100, payee_status: "new" }).allowed, false);
  assert.equal(canApprove(adult, { amount_cents: 100, payee_status: "iban_changed" }).allowed, false);
  assert.equal(canApprove(admin, { amount_cents: 100, payee_status: "iban_changed" }).allowed, true);
});

test("Freigabe-Empfänger", () => {
  const ids = (r) => approversFor([admin, adult, child], r).map((u) => u.id);
  assert.deepEqual(ids({ amount_cents: 1000, payee_status: "known" }), ["a", "b"]);
  assert.deepEqual(ids({ amount_cents: 80000, payee_status: "known" }), ["a"]);
  assert.deepEqual(ids({ amount_cents: 1000, payee_status: "new" }), ["a"]);
});

test("Dublettenschlüssel", () => {
  const base = { issuer: "Stadtwerke  Duisburg", invoice_number: "R-1", iban: "DE89370400440532013000", amount_cents: 8420, invoice_date: "2026-11-01" };
  assert.equal(duplicateKey(base), duplicateKey({ ...base, issuer: "stadtwerke duisburg", amount_cents: 1 }));
  assert.notEqual(duplicateKey(base), duplicateKey({ ...base, invoice_number: "R-2" }));
  assert.match(duplicateKey({ ...base, invoice_number: null }), /^amt:/);
});

test("Kontovorschlag", () => {
  const accounts = [
    { id: "s", label: "Sparkasse", match_names: ["Köhni"], is_default: true },
    { id: "d", label: "DKB", match_names: ["KoeVen"], is_default: false },
  ];
  assert.equal(suggestAccount(accounts, "KoeVen GbR", null)?.id, "d");
  assert.equal(suggestAccount(accounts, "Familie Köhni", null)?.id, "s");
  assert.equal(suggestAccount(accounts, "Unbekannt", null)?.id, "s");
  assert.equal(suggestAccount(accounts, "KoeVen GbR", "s")?.id, "s");
});

import { resolveFolder } from "../dist/adapters/mail.js";
test("Mail-Ordner werden auch über Namen und Spam-Kennung gefunden", () => {
  const f = [{ path: "INBOX", name: "INBOX" }, { path: "Unbekannt", name: "Unbekannt" }, { path: "INBOX/Rechnungen", name: "Rechnungen" }, { path: "Spamverdacht", name: "Spamverdacht", special: "\\Junk" }];
  assert.equal(resolveFolder(f, "unbekannt"), "Unbekannt");
  assert.equal(resolveFolder(f, "Rechnungen"), "INBOX/Rechnungen");
  assert.equal(resolveFolder(f, "Spam"), "Spamverdacht");
  assert.equal(resolveFolder(f, "Gibtsnicht"), undefined);
});

test("IMAP-Fehler werden je Anbieter erklärt", async () => {
  const { explainImap } = await import("../dist/core/admin-api.js");
  assert.match(explainImap({ message: "Command failed", authenticationFailed: true }, "imap.gmail.com"), /App-Passwort/);
  assert.match(explainImap({ message: "Command failed", responseText: "Invalid credentials (Failure)" }, "imap.mail.yahoo.com"), /Yahoo/);
  assert.match(explainImap({ code: "ENOTFOUND" }, "imap.gibtsnicht.de"), /nicht gefunden/);
});
