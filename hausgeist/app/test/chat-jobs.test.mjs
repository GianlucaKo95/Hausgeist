import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatJobs } from "../dist/core/chat-jobs.js";

const later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

test("Wartende App bekommt die Antwort direkt, kein Push", async () => {
  const pushed = [];
  const jobs = new ChatJobs(async (j) => pushed.push(j), 50);
  const job = jobs.start("u1", later(20, "Hallo"));
  const done = await jobs.wait(job.id, "u1", 1000);
  assert.equal(done.reply, "Hallo");
  await later(100);
  assert.equal(pushed.length, 0);
  assert.equal(jobs.open("u1").length, 0);
});

test("App im Hintergrund: Antwort per Push und später abholbar", async () => {
  const pushed = [];
  const jobs = new ChatJobs(async (j) => pushed.push(j), 30);
  const job = jobs.start("u1", later(20, "Fertig"));
  const first = await jobs.wait(job.id, "u1", 5); // App wartet kurz, geht dann weg
  assert.equal(first.status, "running");
  await later(120);
  assert.equal(pushed.length, 1);
  assert.equal(jobs.open("u1").length, 1);
  const back = await jobs.wait(job.id, "u1", 0);
  assert.equal(back.reply, "Fertig");
  assert.equal(jobs.open("u1").length, 0);
  assert.equal(jobs.get(job.id, "u2"), undefined, "fremde Aufträge bleiben unsichtbar");
});
