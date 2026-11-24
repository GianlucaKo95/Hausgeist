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
