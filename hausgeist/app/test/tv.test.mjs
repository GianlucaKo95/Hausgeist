import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TvHub } from "../dist/core/tv-hub.js";

test("Koppeln, Befehl hin und Antwort zurück", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tv-"));
  const hub = new TvHub(dir);
  const { pair_id, code } = hub.startPairing("Wohnzimmer", "AFTKA");
  assert.equal(hub.pollPairing(pair_id).status, "waiting");
  assert.throws(() => hub.confirm("000000"));
  hub.confirm(code);
  const done = hub.pollPairing(pair_id);
  assert.equal(done.status, "done");
  assert.equal(hub.pollPairing(pair_id).status, "expired"); // Schlüssel nur einmal
  const dev = hub.authenticate(`Bearer ${done.token}`);
  assert.equal(dev.name, "Wohnzimmer");
  assert.equal(hub.authenticate("Bearer falsch"), null);

  // aus → klare Meldung
  await assert.rejects(hub.send(dev, "state"), /aus/);
  // Fernseher wartet, Befehl kommt sofort an
  const poll = hub.next(dev, 2000);
  const answer = hub.send(hub.find(), "state", {});
  const cmd = await poll;
  assert.equal(cmd.cmd, "state");
  hub.result(dev, cmd.id, { title: "Pokémon" });
  assert.deepEqual(await answer, { title: "Pokémon" });

  // Befehl wartet in der Schlange, bis der Fernseher wieder fragt
  const queued = hub.send(dev, "key", { k: "ok" });
  const c2 = await hub.next(dev, 500);
  hub.result(dev, c2.id, undefined, "Kinderprofil");
  await assert.rejects(queued, /Kinderprofil/);

  // überlebt Neustart
  assert.equal(new TvHub(dir).list()[0].name, "Wohnzimmer");
  assert.throws(() => hub.find("Küche"), /Wohnzimmer/);
});
