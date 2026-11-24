import { test } from "node:test";
import assert from "node:assert/strict";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { canApproveAction, entityAllowed, isSensitiveHaService, noticeDeadline } from "../dist/core/checks.js";
import { parseEvents, icalDate } from "../dist/adapters/calendar.js";
import { financeTools } from "../dist/tools/finance.js";
import { documentTools } from "../dist/tools/documents.js";
import { shoppingTools } from "../dist/tools/shopping.js";
import { mailTools } from "../dist/tools/mail.js";
import { householdTools } from "../dist/tools/household.js";
import { familyTools } from "../dist/tools/family.js";
import { githubTools } from "../dist/tools/business.js";
import { memoryTools, noteTools, researchTools } from "../dist/tools/memory.js";

const admin = { id: "a", name: "Luca", role: "admin", approval_limit_cents: 0, ha_user_id: "x", notify_service: "m" };
const adult = { id: "b", name: "Partnerin", role: "adult", approval_limit_cents: 50000, ha_user_id: "y", notify_service: "n" };
const child = { id: "c", name: "Kind", role: "child", approval_limit_cents: 0, ha_user_id: "z", notify_service: "o" };

test("Freigaberechte für Aktionen", () => {
  assert.equal(canApproveAction(child, { kind: "calendar_event", amount_cents: null }).allowed, false);
  assert.equal(canApproveAction(adult, { kind: "order", amount_cents: 49_999 }).allowed, true);
  assert.equal(canApproveAction(adult, { kind: "order", amount_cents: 50_001 }).allowed, false);
  assert.equal(canApproveAction(admin, { kind: "order", amount_cents: 500_000 }).allowed, true);
  assert.equal(canApproveAction(adult, { kind: "send_mail", amount_cents: null, mailbox_owner_id: "a" }).allowed, false);
  assert.equal(canApproveAction(adult, { kind: "send_mail", amount_cents: null, mailbox_owner_id: "b" }).allowed, true);
  assert.equal(canApproveAction(admin, { kind: "send_mail", amount_cents: null, mailbox_owner_id: "b" }).allowed, true);
  assert.equal(canApproveAction(adult, { kind: "ha_service", amount_cents: null }).allowed, true);
});

test("Home-Assistant-Whitelist und sensible Domains", () => {
  const p = ["climate.*", "sensor.pv_*", "lock.haustuer"];
  assert.equal(entityAllowed("climate.wohnzimmer", p), true);
  assert.equal(entityAllowed("sensor.pv_leistung", p), true);
  assert.equal(entityAllowed("sensor.temperatur", p), false);
  assert.equal(entityAllowed("lock.haustuer", p), true);
  assert.equal(entityAllowed("lock.haustuerX", p), false);
  assert.equal(isSensitiveHaService("lock"), true);
  assert.equal(isSensitiveHaService("light"), false);
});

test("Kündigungsfrist", () => {
  assert.equal(noticeDeadline("2027-03-31", 90), "2026-12-31");
  assert.equal(noticeDeadline(null, 30), null);
});

test("iCal-Parser", () => {
  const ical = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Elternabend\\, Klasse 2\r\nDTSTART;TZID=Europe/Berlin:20261124T183000\r\nDTEND;TZID=Europe/Berlin:20261124T200000\r\nLOCATION:Schule \r\n am Park\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Urlaub\r\nDTSTART;VALUE=DATE:20261227\r\nEND:VEVENT\r\nEND:VCALENDAR";
  const ev = parseEvents(ical, "Familie");
  assert.equal(ev.length, 2);
  assert.equal(ev[0].title, "Elternabend, Klasse 2");
  assert.equal(ev[0].start, "2026-11-24T18:30:00+01:00");
  assert.equal(ev[0].location, "Schule am Park");
  assert.equal(ev[1].allDay, true);
  assert.equal(icalDate("20261124T173000Z"), "2026-11-24T17:30:00Z");
});

test("Alle Werkzeuge lassen sich als MCP-Server registrieren", () => {
  const ctx = { config: { mailboxes: [], ha_entities: [], energy: {}, calendars: [] }, user: admin };
  const sets = {
    finance: financeTools(ctx), documents: documentTools(ctx), shopping: shoppingTools(ctx),
    mail: mailTools(ctx, "private", "communication"), household: householdTools(ctx), family: familyTools(ctx),
    business: [...mailTools(ctx, "business", "business"), ...githubTools(ctx)],
    research: researchTools(ctx), master: [...memoryTools(ctx), ...noteTools(ctx)],
  };
  let count = 0;
  for (const [name, tools] of Object.entries(sets)) {
    const names = tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, `doppelte Werkzeugnamen in ${name}`);
    const server = createSdkMcpServer({ name, tools });
    assert.equal(server.type, "sdk");
    count += tools.length;
  }
  assert.ok(count >= 80, `nur ${count} Werkzeuge`);
});
