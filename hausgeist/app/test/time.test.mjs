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

test("Termine schreiben: ganztägig und mit Uhrzeit", async () => {
  const { buildIcal, parseEvents } = await import("../dist/adapters/calendar.js");
  const day = buildIcal("u1", { title: "Ausflug", start: "2026-12-05", end: "2026-12-05", allDay: true });
  assert.match(day, /DTSTART;VALUE=DATE:20261205/);
  assert.match(day, /DTEND;VALUE=DATE:20261206/);
  const timed = buildIcal("u2", { title: "Elternabend; Klasse 2", start: "2026-12-03T19:00:00+01:00", end: "2026-12-03T20:30:00+01:00" });
  const [ev] = parseEvents(timed, "Familie");
  assert.equal(ev.title, "Elternabend; Klasse 2");
  assert.equal(ev.start, "2026-12-03T19:00:00+01:00");
  assert.equal(ev.recurring, false);
});

test("Mail-Überblick: alle Ordner außer Gesendet/Entwürfe/Papierkorb", async () => {
  const { skipFolder } = await import("../dist/core/scheduler.js");
  assert.equal(skipFolder({ path: "INBOX", name: "INBOX" }), false);
  assert.equal(skipFolder({ path: "Unbekannt", name: "Unbekannt" }), false);
  assert.equal(skipFolder({ path: "Spam", name: "Spam", special: "\\Junk" }), false);
  assert.equal(skipFolder({ path: "Rechnungen", name: "Rechnungen" }), false);
  assert.equal(skipFolder({ path: "Gesendet", name: "Gesendet" }), true);
  assert.equal(skipFolder({ path: "[Gmail]/All Mail", name: "All Mail", special: "\\All" }), true);
  assert.equal(skipFolder({ path: "Papierkorb", name: "Papierkorb", special: "\\Trash" }), true);
});

test("Sprachchat: Text kommt schon während der Antwort, danach das Ergebnis", async () => {
  const { ChatJobs } = await import("../dist/core/chat-jobs.js");
  const jobs = new ChatJobs(async () => undefined, 10);
  let finish;
  const job = jobs.start("u1", new Promise((r) => { finish = r; }));
  const seen = [];
  jobs.pushText(job.id, "Moment, ");
  jobs.subscribe(job.id, "u1", (e) => seen.push(e));
  jobs.pushText(job.id, "ich schau nach.");
  assert.equal(jobs.subscribe(job.id, "fremd", () => {}), undefined);
  finish("Fertig.");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen.map((e) => e.t), ["text", "text", "done"]);
  assert.equal(seen[0].d, "Moment, ");
  assert.equal(seen[2].reply, "Fertig.");
});
