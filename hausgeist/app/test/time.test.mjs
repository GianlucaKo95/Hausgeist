import { test } from "node:test";
import assert from "node:assert/strict";
import { icalToBerlin, isoToBerlin, parseBerlin, berlinIso, berlinText } from "../dist/core/time.js";

test("iCal: TZID, schwebend und UTC landen auf 19:00 deutscher Zeit", () => {
  assert.equal(icalToBerlin("20261124T190000", ";TZID=Europe/Berlin"), "2026-11-24T19:00:00+01:00");
  assert.equal(icalToBerlin("20261124T190000"), "2026-11-24T19:00:00+01:00");
  assert.equal(icalToBerlin("20261124T180000Z"), "2026-11-24T19:00:00+01:00");
  assert.equal(icalToBerlin("20260624T170000Z"), "2026-06-24T19:00:00+02:00");
  assert.equal(icalToBerlin("20261124T130000", ';TZID="America/New_York"'), "2026-11-24T19:00:00+01:00");
  assert.equal(icalToBerlin("20261124"), "2026-11-24");
});

test("Home Assistant & Modell-Zeiten", () => {
  assert.equal(isoToBerlin("2026-11-24T18:00:00Z"), "2026-11-24T19:00:00+01:00");
  assert.equal(parseBerlin("2026-11-24T19:00:00").toISOString(), "2026-11-24T18:00:00.000Z");
  assert.equal(parseBerlin("2026-07-01T19:00").toISOString(), "2026-07-01T17:00:00.000Z");
  assert.equal(parseBerlin("2026-11-24T19:00:00+01:00").toISOString(), "2026-11-24T18:00:00.000Z");
  assert.equal(berlinIso(new Date("2026-03-29T01:30:00Z")), "2026-03-29T03:30:00+02:00");
  assert.match(berlinText(new Date("2026-11-24T18:00:00Z")), /19:00$/);
});
