import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blzFromIban, preferDecoupled, FinTSProvider, SwitchingProvider, DryRunProvider } from "../dist/adapters/payment.js";
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
  cfg.fints_product_id = "ABCDEF0123456789ABCDEF012";
  r = await fints.transfer(order);
  assert.match(r.error, /kein Bankzugang/);
});

test("Zahlungsmodus wird live umgeschaltet und Bankzugänge bleiben auf dem Pi", async () => {
  const { cfg, dir } = config();
  const store = new SettingsStore(cfg);
  const payments = new SwitchingProvider(cfg, new DryRunProvider(), new FinTSProvider(cfg));
  assert.equal((await payments.transfer(order)).status, "dryrun");
  await store.update({ payment_mode: "fints", fints_product_id: "ABCDEF0123456789ABCDEF012", bank_logins: { dkb: { login: "kunde", pin: "geheim" } } });
  assert.equal(payments.name, "fints");
  const saved = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.equal(saved.bank_logins.dkb.pin, "geheim");
  assert.equal(cfg.daily_brief, "07:30", "andere Einstellungen bleiben unverändert");
  const { bankInfo } = await import("../dist/core/banks.js");
  assert.equal(bankInfo(cfg, "dkb").name, "DKB", "alte Schlüssel laufen weiter");
});

test("Jede Bank: Verzeichnis, Suche und Zuordnung per IBAN", async () => {
  const { bankByBlz, searchBanks, loginForIban, bankInfo, keyForBlz } = await import("../dist/core/banks.js");
  assert.equal(bankByBlz("35050000").name, "Sparkasse Duisburg");
  assert.ok(searchBanks("Volksbank").length > 0);
  assert.ok(searchBanks("3505").some((b) => b.blz === "35050000"));
  const cfg = { bank_logins: { [keyForBlz("35050000")]: { login: "x", pin: "y", blz: "35050000" } } };
  assert.equal(loginForIban(cfg, "DE89 3505 0000 0123 4567 89"), "blz_35050000");
  assert.equal(bankInfo(cfg, "blz_35050000").url, "https://banking-rl4.s-fints-pt-rl.de/fints30");
  assert.equal(loginForIban(cfg, "DE02120300000000202051"), null);
});

test("Veraltete FinTS-Adressen werden auf die aktuellen umgestellt", async () => {
  const { bankByBlz, searchBanks } = await import("../dist/core/banks.js");
  assert.equal(bankByBlz("30060601").url, "https://fints.apobank.de/FinTs30PinTanHttpGate");
  const vr = searchBanks("Volksbank").find((b) => b.url.includes("atruvia"));
  assert.ok(vr, "Volksbanken über Atruvia");
  assert.ok(!searchBanks("Volksbank").some((b) => /fiducia|gad\.de/.test(b.url)));
  assert.equal(bankByBlz("33060592").url, "https://fints1.atruvia.de/cgi-bin/hbciservlet");
});
