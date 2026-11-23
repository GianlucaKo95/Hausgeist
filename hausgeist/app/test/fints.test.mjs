import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blzFromIban, preferDecoupled, FinTSProvider, SwitchingProvider, DryRunProvider, BANK_INFO } from "../dist/adapters/payment.js";
import { loadConfig } from "../dist/core/config.js";
import { SettingsStore } from "../dist/core/settings.js";

function config() {
  const dir = mkdtempSync(join(tmpdir(), "hg-fints-"));
  writeFileSync(join(dir, "options.json"), JSON.stringify({ anthropic_api_key: "x", supabase_url: "https://a.supabase.co", supabase_service_key: "y" }));
  process.env.HAUSGEIST_OPTIONS = join(dir, "options.json");
  process.env.HAUSGEIST_DATA = dir;
  return { cfg: loadConfig(), dir };
}

const order = {
  bank: "dkb", fromIban: "DE02120300000000202051", debtorName: "Test", toIban: "DE89370400440532013000",
  toName: "Stadtwerke", amountCents: 1234, reference: "RE 1", endToEndId: "abc",
};

test("Bankleitzahl aus IBAN, nur deutsche IBANs", () => {
  assert.equal(blzFromIban("DE02 1203 0000 0000 2020 51"), "12030000");
  assert.throws(() => blzFromIban("AT611904300234573201"));
});

test("App-Freigabe wird vor TAN-Eingabe bevorzugt", () => {
  const sorted = preferDecoupled([{ name: "chipTAN optisch" }, { name: "SMS" }, { name: "S-pushTAN", decoupledMaxStatusRequests: 60 }]);
  assert.equal(sorted[0].name, "S-pushTAN");
  assert.equal(preferDecoupled([{ name: "chipTAN" }, { name: "BestSign" }])[0].name, "BestSign");
});

test("FinTS ohne Produkt-ID oder Bankzugang scheitert verständlich – ohne Bankverbindung", async () => {
  const { cfg } = config();
  const fints = new FinTSProvider(cfg);
  let r = await fints.transfer(order);
  assert.equal(r.status, "failed");
  assert.match(r.error, /Produkt-ID/);
  cfg.fints_product_id = "ABC123";
  r = await fints.transfer(order);
  assert.match(r.error, /kein Bankzugang/);
});

test("Zahlungsmodus wird live umgeschaltet und Bankzugänge bleiben auf dem Pi", async () => {
  const { cfg, dir } = config();
  const store = new SettingsStore(cfg);
  const payments = new SwitchingProvider(cfg, new DryRunProvider(), new FinTSProvider(cfg));
  assert.equal((await payments.transfer(order)).status, "dryrun");
  await store.update({ payment_mode: "fints", fints_product_id: "ABC123", bank_logins: { dkb: { login: "kunde", pin: "geheim" } } });
  assert.equal(payments.name, "fints");
  const saved = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.equal(saved.bank_logins.dkb.pin, "geheim");
  assert.equal(cfg.daily_brief, "07:30", "andere Einstellungen bleiben unverändert");
  assert.ok(BANK_INFO.sparkasse_duisburg.url.startsWith("https://"));
});
