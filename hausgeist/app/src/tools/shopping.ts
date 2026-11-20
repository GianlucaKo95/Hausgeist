import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { db } from "../core/db.js";
import { formatEuro } from "../core/checks.js";
import { ok, safe, requireAdult, type ToolContext } from "./context.js";

export function shoppingTools(ctx: ToolContext) {
  return [
    tool("shopping_list", "Aktuelle Einkaufsliste.", { include_done: z.boolean().default(false) }, safe(async (a) => {
      let q = db().from("shopping_lists").select("id, item, quantity, done, created_at").order("created_at");
      if (!a.include_done) q = q.eq("done", false);
      const { data, error } = await q;
      if (error) throw error;
      return ok(data ?? []);
    })),

    tool("add_to_list", "Artikel auf die Einkaufsliste setzen (auch für Kinder erlaubt).", {
      items: z.array(z.object({ item: z.string(), quantity: z.string().optional() })).min(1),
    }, safe(async (a) => {
      const { error } = await db().from("shopping_lists").insert(a.items.map((i) => ({ ...i, added_by: ctx.user.id })));
      if (error) throw error;
      return ok(`${a.items.length} Artikel hinzugefügt`);
    })),

    tool("check_off", "Artikel als erledigt markieren.", { ids: z.array(z.string().uuid()).min(1) }, safe(async (a) => {
      const { error } = await db().from("shopping_lists").update({ done: true }).in("id", a.ids);
      if (error) throw error;
      return ok("Abgehakt");
    })),

    tool("recurring_purchases", "Artikel, die regelmäßig auf der Liste landen (Basis für wiederkehrende Einkäufe).", {
      min_count: z.number().int().min(2).default(3),
    }, safe(async (a) => {
      const since = new Date(Date.now() - 120 * 86_400_000).toISOString();
      const { data, error } = await db().from("shopping_lists").select("item, created_at").gte("created_at", since);
      if (error) throw error;
      const counts = new Map<string, number>();
      for (const r of data ?? []) {
        const k = String(r.item).trim().toLowerCase();
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      return ok([...counts].filter(([, n]) => n >= a.min_count).map(([item, n]) => ({ item, mal_in_120_tagen: n })));
    })),

    tool("request_order", "Bestellung zur Freigabe vorlegen (Stufe 2). Wird erst nach Klick eines Berechtigten ausgeführt.", {
      shop: z.string(),
      items: z.array(z.object({
        name: z.string(), quantity: z.number().int().min(1), price_euro: z.number().nonnegative(), url: z.string().url().optional(),
      })).min(1),
      note: z.string().optional(),
    }, safe(async (a) => {
      requireAdult(ctx);
      const items = a.items.map((i) => ({ name: i.name, quantity: i.quantity, price_cents: Math.round(i.price_euro * 100), url: i.url ?? null }));
      const total = items.reduce((s, i) => s + i.price_cents * i.quantity, 0);
      const summary = `${a.shop}: ${items.map((i) => `${i.quantity}× ${i.name}`).join(", ")} – ${formatEuro(total)}`;
      const r = await ctx.actions.request("order", { shop: a.shop, items, total_cents: total, note: a.note ?? null }, { agent: "shopping", summary, requestedBy: ctx.user });
      return ok({ status: "Freigabe angefragt", an: r.approvers, gesamt: formatEuro(total) });
    })),
  ];
}
