import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, readAppSettings } from "../dist/core/config.js";
import { SettingsStore } from "../dist/core/settings.js";

test("Einstellungen aus der App überlagern die Add-on-Konfiguration und bleiben auf dem Pi", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hg-"));
  writeFileSync(join(dir, "options.json"), JSON.stringify({
    anthropic_api_key: "x", supabase_url: "https://a.supabase.co", supabase_service_key: "y",
    daily_brief: "07:30", mailboxes: [],
  }));
  process.env.HAUSGEIST_OPTIONS = join(dir, "options.json");
  process.env.HAUSGEIST_DATA = dir;
  const config = loadConfig();
  assert.equal(config.daily_brief, "07:30");

  const store = new SettingsStore(config);
  const seen = [];
  store.onChange((k) => { seen.push(...k); });
  await store.update({
    daily_brief: "06:45",
    mailboxes: [{ name: "privat", host: "imap.example.de", port: 993, tls: true, user: "a@b.de", password: "geheim" }],
  });
  assert.equal(config.daily_brief, "06:45");                 // live übernommen
  assert.deepEqual(seen.sort(), ["daily_brief", "mailboxes"]);
  assert.equal(readAppSettings(dir).mailboxes[0].password, "geheim");
  assert.equal(statSync(join(dir, "settings.json")).mode & 0o777, 0o600); // nur für das Add-on lesbar

  // Neustart: Overlay gewinnt
  const again = loadConfig();
  assert.equal(again.daily_brief, "06:45");
  assert.equal(again.mailboxes.length, 1);

  // Ungültiges wird abgelehnt und nichts gespeichert
  await assert.rejects(store.update({ daily_brief: "25:00" }));
  assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).daily_brief, "06:45");
});
