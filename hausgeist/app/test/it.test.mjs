import { test } from "node:test";
import assert from "node:assert/strict";
import { digestHeader, xmlValue } from "../dist/adapters/fritzbox.js";
import { encodePowerShell } from "../dist/adapters/pc.js";
import { canApproveAction } from "../dist/core/checks.js";

test("Digest-Anmeldung nach RFC 2617 (Beispiel aus dem Standard)", () => {
  const h = digestHeader({
    user: "Mufasa", password: "Circle Of Life", method: "GET", uri: "/dir/index.html",
    challenge: 'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    nc: "00000001", cnonce: "0a4f113b",
  });
  assert.match(h, /response="6629fae49393a05397450978507c4ef1"/);
});

test("TR-064-Antworten werden gelesen", () => {
  const xml = '<s:Envelope><s:Body><u:GetInfoResponse><NewModelName>FRITZ!Box 7590 AX</NewModelName><NewSSID>Gäste &amp; Co</NewSSID></u:GetInfoResponse></s:Body></s:Envelope>';
  assert.equal(xmlValue(xml, "NewModelName"), "FRITZ!Box 7590 AX");
  assert.equal(xmlValue(xml, "NewSSID"), "Gäste & Co");
});

test("PowerShell-Befehl wird als UTF-16LE kodiert, Anführungszeichen bleiben erhalten", () => {
  const cmd = 'winget install --id "Mozilla.Firefox" -e';
  const decoded = Buffer.from(encodePowerShell(cmd), "base64").toString("utf16le");
  assert.ok(decoded.endsWith(cmd));
});

test("PC-Befehle und FRITZ!Box-Neustart darf nur der Admin freigeben", () => {
  const admin = { id: "a", role: "admin", approval_limit_cents: 0 };
  const adult = { id: "b", role: "adult", approval_limit_cents: 50000 };
  assert.equal(canApproveAction(admin, { kind: "pc_command", amount_cents: null }).allowed, true);
  assert.equal(canApproveAction(adult, { kind: "pc_command", amount_cents: null }).allowed, false);
  assert.equal(canApproveAction(adult, { kind: "fritz_reboot", amount_cents: null }).allowed, false);
});

import { looksLikeComputer, WindowsPc, discoverComputers } from "../dist/adapters/pc.js";
import { mkdtempSync as mk } from "node:fs";
import { tmpdir as td } from "node:os";
import { join as jn } from "node:path";

test("Computer in der FRITZ!Box-Liste erkennen", () => {
  for (const n of ["DESKTOP-4KQ7P2L", "LAPTOP-AB12CD", "Lucas-MacBook-Pro", "ThinkPad-X1", "Annikas-PC"]) assert.ok(looksLikeComputer(n), n);
  for (const n of ["iPhone-von-Luca", "FRITZ-Repeater-3000", "Shelly-Plug", "Echo-Dot", "SamsungTV"]) assert.ok(!looksLikeComputer(n), n);
});

test("Mehrere Computer: Auswahl nach Name, Nachfrage bei Mehrdeutigkeit", () => {
  const dir = mk(jn(td(), "hg-pc-"));
  const cfg = { dataDir: dir, pc: { name: "PC", host: "", port: 22, user: "", mac: "" },
    pcs: [{ name: "PC", host: "192.168.178.20", port: 22, user: "luca", mac: "" }, { name: "Laptop", host: "192.168.178.31", port: 22, user: "luca", mac: "" }] };
  const pc = new WindowsPc(cfg);
  assert.equal(pc.find("laptop").host, "192.168.178.31");
  assert.equal(pc.find("Luca Laptop").name, "Laptop");
  assert.throws(() => pc.find(), /Welcher Computer/);
  assert.throws(() => pc.find("Tablet"), /kenne ich nicht/);
  const legacy = new WindowsPc({ dataDir: dir, pc: { name: "PC", host: "10.0.0.2", port: 22, user: "x", mac: "" }, pcs: [] });
  assert.equal(legacy.find().host, "10.0.0.2");
});

test("Discovery: ausgeschaltete Geräte ohne Netzwerkprüfung, eingerichtete werden erkannt", async () => {
  const r = await discoverComputers(
    [{ name: "LAPTOP-AB12", ip: "192.168.178.31", mac: "aa:bb:cc:dd:ee:ff", active: false, connection: "802.11" },
     { name: "iPhone", ip: "192.168.178.40", mac: "11:22:33:44:55:66", active: true, connection: "802.11" }],
    [{ name: "Laptop", host: "192.168.178.31", port: 22, user: "luca", mac: "" }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].configuredAs, "Laptop");
  assert.equal(r[0].ssh, false);
});
