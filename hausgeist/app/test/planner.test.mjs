import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlannerLink } from "../dist/core/planner-link.js";
import { buildIcal, parseEvents } from "../dist/adapters/calendar.js";

test("Familienplaner koppeln: Code → Schlüssel genau einmal, nur gehasht gespeichert", () => {
  const dir = mkdtempSync(join(tmpdir(), "pl-"));
  const link = new PlannerLink(dir);
  const { pair_id, code } = link.startPairing("Küchentablet");
  assert.equal(link.pollPairing(pair_id).status, "waiting");
  assert.throws(() => link.confirm("000000"), /unbekannt/);
  const dev = link.confirm(code);
  assert.equal(dev.name, "Küchentablet");
  const done = link.pollPairing(pair_id);
  assert.equal(done.status, "done");
  assert.match(done.token, /^hp_/);
  assert.equal(link.pollPairing(pair_id).status, "expired");
  assert.ok(!JSON.stringify(new PlannerLink(dir).list()).includes(done.token));
  link.remove(dev.id);
  assert.equal(link.list().length, 0);
});

test("Ganztägige und zeitliche Termine fürs Schreiben in den Apple-Kalender", () => {
  const day = buildIcal("u1", { title: "Ausflug", start: "2026-12-05", end: "2026-12-05", allDay: true });
  assert.match(day, /DTSTART;VALUE=DATE:20261205/);
  assert.match(day, /DTEND;VALUE=DATE:20261206/);
  const timed = buildIcal("u2", { title: "Elternabend; Klasse 2", start: "2026-12-03T19:00:00+01:00", end: "2026-12-03T20:30:00+01:00" });
  assert.match(timed, /DTSTART:20261203T180000Z/);
  const [ev] = parseEvents(timed, "Familie");
  assert.equal(ev.title, "Elternabend; Klasse 2");
  assert.equal(ev.start, "2026-12-03T19:00:00+01:00");
  assert.equal(ev.uid, "u2");
  assert.equal(ev.recurring, false);
});
