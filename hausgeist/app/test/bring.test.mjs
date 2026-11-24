import { test } from "node:test";
import assert from "node:assert/strict";
import { bringListFor, bringId, parseBringId, ShoppingList } from "../dist/core/shopping-list.js";
import { AppSettings } from "../dist/core/config.js";

const lists = [
  { name: "Zuhause", entity_id: "todo.zuhause", stores: ["Rewe", "Aldi", "dm"], default: true },
  { name: "Party", entity_id: "todo.party", stores: [], default: false },
];

test("Laden wird der richtigen Bring!-Liste zugeordnet", () => {
  assert.equal(bringListFor(lists, undefined).entity_id, "todo.zuhause");
  assert.equal(bringListFor(lists, "aldi").entity_id, "todo.zuhause");
  assert.equal(bringListFor(lists, "Party").entity_id, "todo.party");
  assert.equal(bringListFor(lists, "Baumarkt"), undefined);
  assert.equal(bringListFor([], undefined), undefined);
});

test("Bring!-Kennung hin und zurück", () => {
  assert.deepEqual(parseBringId(bringId("todo.zuhause", "a-b:c")), { entity: "todo.zuhause", uid: "a-b:c" });
  assert.equal(parseBringId("6f1c2d3e-0000-4000-8000-000000000000"), undefined);
});

test("Lebensmittel gehen nach Bring!, Doppeltes wird übersprungen, Abhaken läuft über Home Assistant", async () => {
  const calls = [];
  const ha = {
    async callServiceWithResponse(domain, service, data) {
      calls.push([service, data]);
      return { [data.entity_id]: { items: [{ uid: "u1", summary: "Milch", description: "2 Liter", status: "needs_action" }] } };
    },
    async callService(domain, service, data) { calls.push([service, data]); },
  };
  const s = new ShoppingList({ bring_lists: lists }, ha);
  const r = await s.add([{ item: "milch" }, { item: "Bananen", quantity: "6" }]);
  assert.deepEqual(r, { bring: 1, own: 0 });
  const add = calls.find(([svc]) => svc === "add_item");
  assert.deepEqual(add[1], { entity_id: "todo.zuhause", item: "Bananen", description: "6" });

  const items = await s.list("Rewe");
  assert.equal(items[0].item, "Milch");
  assert.equal(items[0].quantity, "2 Liter");
  await s.checkOff([items[0].id]);
  assert.deepEqual(calls.at(-1), ["update_item", { entity_id: "todo.zuhause", item: "u1", status: "completed" }]);
  await assert.rejects(s.checkOff(["bring:todo.fremd:x"]), /keine eingerichtete/);
});

test("Bring!-Listen lassen sich in der App speichern", () => {
  const p = AppSettings.parse({ bring_lists: [{ name: "Zuhause", entity_id: "todo.zuhause" }] });
  assert.equal(p.bring_lists[0].default, false);
  assert.throws(() => AppSettings.parse({ bring_lists: [{ name: "X", entity_id: "light.kueche" }] }));
});

test("Direkt bei Bring!: Hinzufügen und Abhaken ohne Home Assistant", async () => {
  const calls = [];
  const fake = {
    async items() { return [{ uuid: "u-1", name: "Milch", spec: "2 Liter", done: false }]; },
    async add(list, name, spec) { calls.push(["add", list, name, spec]); },
    async complete(list, name, uuid) { calls.push(["complete", list, name, uuid]); },
  };
  const uuid = "12345678-1234-1234-1234-123456789abc";
  const s = new ShoppingList({ bring_lists: [{ name: "Zuhause", list_uuid: uuid, stores: [], default: true }] }, {}, fake);
  const r = await s.add([{ item: "Milch" }, { item: "Äpfel", quantity: "1 kg" }]);
  assert.deepEqual(r, { bring: 1, own: 0 });
  assert.deepEqual(calls[0], ["add", uuid, "Äpfel", "1 kg"]);
  const items = await s.list("Zuhause");
  await s.checkOff([items[0].id]);
  assert.deepEqual(calls.at(-1), ["complete", uuid, "Milch", "u-1"]);
});
