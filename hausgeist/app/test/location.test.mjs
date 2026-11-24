import { test } from "node:test";
import assert from "node:assert/strict";
import { zoneEdge, normZone, personFor, positionOf, leaveAt } from "../dist/core/location.js";

test("Verlassen und Erreichen werden nur beim Wechsel erkannt", () => {
  assert.equal(zoneEdge("home", "not_home", "zuhause", "leave"), true);
  assert.equal(zoneEdge("not_home", "not_home", "home", "leave"), false);
  assert.equal(zoneEdge("not_home", "Arbeit", "arbeit", "enter"), true);
  assert.equal(zoneEdge(null, "home", "home", "enter"), false, "erster Blick löst nichts aus");
  assert.equal(normZone("Zuhause"), "home");
});

test("Person wird über die Home-Assistant-Benutzer-ID gefunden", () => {
  const states = [
    { entity_id: "person.annika", state: "home", attributes: { user_id: "ha-a", latitude: 51.4, longitude: 6.7 } },
    { entity_id: "person.luca", state: "not_home", attributes: { user_id: "ha-l", latitude: 51.2, longitude: 6.8 } },
  ];
  const p = personFor({ id: "u", ha_user_id: "ha-l" }, states);
  assert.equal(p.entity_id, "person.luca");
  assert.deepEqual(positionOf(p, states).lat, 51.2);
  assert.equal(personFor({ id: "x", ha_user_id: null }, states), undefined);
});

test("Losfahrzeit: Fahrzeit + Verkehrszuschlag + Puffer", () => {
  const start = new Date("2026-11-25T15:00:00Z");
  assert.equal(leaveAt(start, 20, 10, "car").toISOString(), "2026-11-25T14:27:00.000Z"); // 23 + 10 Min.
  assert.equal(leaveAt(start, 20, 10, "foot").toISOString(), "2026-11-25T14:30:00.000Z");
});

import { zoneAt, distanceM, Positions } from "../dist/core/location.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Zone aus App-Position und Geofence-Ereignissen", () => {
  const list = [{ name: "home", lat: 51.4, lon: 6.75, radius: 100 }, { name: "Arbeit", lat: 51.22, lon: 6.78, radius: 150 }];
  assert.equal(zoneAt({ lat: 51.4003, lon: 6.7502 }, list), "home");
  assert.equal(zoneAt({ lat: 51.3, lon: 6.7 }, list), "not_home");
  assert.ok(Math.abs(distanceM({ lat: 51.4, lon: 6.75 }, { lat: 51.41, lon: 6.75 }) - 1112) < 5);
  const p = new Positions(mkdtempSync(join(tmpdir(), "hg-pos-")));
  p.zoneEvent("u", "home", "enter");
  assert.equal(p.get("u").zone, "home");
  p.zoneEvent("u", "home", "leave");
  assert.equal(p.get("u").zone, "not_home");
});
