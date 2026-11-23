import { db } from "./db.js";
import type { Config } from "./config.js";
import type { HomeAssistant } from "../adapters/homeassistant.js";
import { logger } from "./log.js";

const log = logger("einkauf");

export interface ListItem {
  id: string;
  item: string;
  quantity?: string | null;
  store?: string | null;
  category?: string | null;
  done?: boolean;
  source: "bring" | "hausgeist";
}

export interface NewItem {
  item: string;
  quantity?: string;
  store?: string;
  category?: string;
}

type BringList = Config["bring_lists"][number];
type TodoItem = { uid: string; summary: string; description?: string | null; status: "needs_action" | "completed" };

const norm = (s: string) => s.trim().toLowerCase();

/** Welche Bring!-Liste ist für diesen Laden zuständig? Ohne Laden: die Standardliste. */
export function bringListFor(lists: BringList[], store?: string | null): BringList | undefined {
  if (lists.length === 0) return undefined;
  if (store) {
    const s = norm(store);
    return lists.find((l) => norm(l.name) === s || l.stores.some((x) => norm(x) === s));
  }
  return lists.find((l) => l.default) ?? lists[0];
}

/** Bring!-Einträge tragen eine Kennung, die Liste und Eintrag enthält. */
export const bringId = (entity: string, uid: string) => `bring:${entity}:${uid}`;
export function parseBringId(id: string): { entity: string; uid: string } | undefined {
  const m = id.match(/^bring:(todo\.[a-z0-9_]+):(.+)$/);
  return m ? { entity: m[1], uid: m[2] } : undefined;
}

/**
 * Einkaufsliste: Lebensmittel & Co. landen über die Home-Assistant-Integration
 * direkt in Bring!, alles andere (z. B. Baumarkt) in der eigenen Liste.
 * Bring! bleibt dabei die Quelle – was in der Bring!-App abgehakt wird, ist erledigt.
 */
export class ShoppingList {
  constructor(private readonly config: Config, private readonly ha: HomeAssistant) {}

  private get lists(): BringList[] {
    return this.config.bring_lists ?? [];
  }

  private async bringItems(list: BringList, includeDone: boolean): Promise<ListItem[]> {
    const status = includeDone ? ["needs_action", "completed"] : ["needs_action"];
    const res = await this.ha.callServiceWithResponse<Record<string, { items: TodoItem[] }>>("todo", "get_items", {
      entity_id: list.entity_id,
      status,
    });
    return (res[list.entity_id]?.items ?? []).map((t) => ({
      id: bringId(list.entity_id, t.uid),
      item: t.summary,
      quantity: t.description || null,
      store: list.name,
      done: t.status === "completed",
      source: "bring" as const,
    }));
  }

  async list(store?: string, includeDone = false): Promise<ListItem[]> {
    const out: ListItem[] = [];
    const target = store ? bringListFor(this.lists, store) : undefined;
    const bringLists = store ? (target ? [target] : []) : this.lists;
    for (const l of bringLists) {
      try {
        out.push(...(await this.bringItems(l, includeDone)));
      } catch (e) {
        log.error(`Bring!-Liste ${l.name} nicht lesbar`, e);
        throw new Error(`Die Bring!-Liste „${l.name}“ ist gerade nicht erreichbar (${l.entity_id}).`);
      }
    }
    if (!target) {
      let q = db().from("shopping_lists").select("id, item, quantity, store, category, done")
        .order("store", { nullsFirst: false }).order("category").order("created_at");
      if (!includeDone) q = q.eq("done", false);
      if (store) q = q.ilike("store", store);
      const { data, error } = await q;
      if (error) throw error;
      // Ohne Bring!-Liste bleibt alles in der eigenen Liste – mit Bring! nur, was keinen Bring!-Laden hat.
      out.push(...(data ?? []).map((d) => ({ ...d, source: "hausgeist" as const })));
    }
    return out;
  }

  /** Gibt zurück, wohin die Artikel gegangen sind. */
  async add(items: NewItem[], addedBy?: string): Promise<{ bring: number; own: number }> {
    const own: NewItem[] = [];
    let bring = 0;
    for (const i of items) {
      const list = bringListFor(this.lists, i.store);
      if (!list) { own.push(i); continue; }
      const open = await this.bringItems(list, false).catch(() => []);
      if (open.some((o) => norm(o.item) === norm(i.item))) continue; // steht schon drauf
      await this.ha.callService("todo", "add_item", {
        entity_id: list.entity_id,
        item: i.item,
        ...(i.quantity ? { description: i.quantity } : {}),
      });
      bring++;
    }
    if (own.length) {
      const { error } = await db().from("shopping_lists").insert(own.map((i) => ({ ...i, added_by: addedBy ?? null })));
      if (error) throw error;
    }
    return { bring, own: own.length };
  }

  async checkOff(ids: string[]): Promise<void> {
    const own: string[] = [];
    for (const id of ids) {
      const b = parseBringId(id);
      if (!b) { own.push(id); continue; }
      if (!this.lists.some((l) => l.entity_id === b.entity)) throw new Error(`${b.entity} ist keine eingerichtete Bring!-Liste.`);
      await this.ha.callService("todo", "update_item", { entity_id: b.entity, item: b.uid, status: "completed" });
    }
    if (own.length) {
      const { error } = await db().from("shopping_lists").update({ done: true }).in("id", own);
      if (error) throw error;
    }
  }

  /** Steht der Artikel schon offen auf der passenden Liste? */
  async isOpen(item: string, store?: string | null): Promise<boolean> {
    const list = bringListFor(this.lists, store);
    if (list) return (await this.bringItems(list, false)).some((o) => norm(o.item) === norm(item));
    const { data } = await db().from("shopping_lists").select("id").eq("done", false).ilike("item", item).limit(1);
    return Boolean(data?.length);
  }
}
