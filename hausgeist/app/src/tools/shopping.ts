import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { db } from "../core/db.js";
import { formatEuro } from "../core/checks.js";
import { ok, safe, requireAdult, findUser, type ToolContext } from "./context.js";

export function shoppingTools(ctx: ToolContext) {
  return [
    // ── Einkaufsliste ──────────────────────────────────────────────────────
    tool("shopping_list", "Einkaufsliste, optional nur für einen Laden; sortiert nach Laden und Abteilung.", {
      store: z.string().optional(),
      include_done: z.boolean().default(false),
    }, safe(async (a) => {
      let q = db().from("shopping_lists").select("id, item, quantity, store, category, done").order("store", { nullsFirst: false }).order("category").order("created_at");
      if (!a.include_done) q = q.eq("done", false);
      if (a.store) q = q.ilike("store", a.store);
      const { data, error } = await q;
      if (error) throw error;
      return ok(data ?? []);
    })),

    tool("add_to_list", "Artikel auf die Einkaufsliste setzen (auch für Kinder). Laden und Abteilung (z. B. Obst & Gemüse, Kühlregal, Drogerie) mit angeben, wenn bekannt.", {
      items: z.array(z.object({
        item: z.string(), quantity: z.string().optional(), store: z.string().optional(), category: z.string().optional(),
      })).min(1),
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

    tool("recurring_purchases", "Artikel, die häufig auf der Liste landen – Vorschläge für wiederkehrende Einkäufe.", {
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

    // ── Wiederkehrende Artikel ─────────────────────────────────────────────
    tool("set_recurring_item", "Artikel, der automatisch in einem Rhythmus auf die Liste kommt, z. B. Kaffee alle 14 Tage.", {
      item: z.string(), interval_days: z.number().int().min(1), quantity: z.string().optional(),
      store: z.string().optional(), next_due: z.string().optional().describe("JJJJ-MM-TT, Standard: heute + Intervall"),
    }, safe(async (a) => {
      requireAdult(ctx);
      const next = a.next_due ?? new Date(Date.now() + a.interval_days * 86_400_000).toISOString().slice(0, 10);
      const { error } = await db().from("recurring_items").insert({ item: a.item, interval_days: a.interval_days, quantity: a.quantity ?? null, store: a.store ?? null, next_due: next });
      if (error) throw error;
      return ok(`${a.item} kommt alle ${a.interval_days} Tage auf die Liste, zuerst am ${next}`);
    })),

    tool("list_recurring_items", "Wiederkehrende Artikel.", {}, safe(async () => {
      const { data, error } = await db().from("recurring_items").select("*").eq("active", true).order("next_due");
      if (error) throw error;
      return ok(data ?? []);
    })),

    tool("stop_recurring_item", "Wiederkehrenden Artikel beenden.", { id: z.string().uuid() }, safe(async (a) => {
      requireAdult(ctx);
      await db().from("recurring_items").update({ active: false }).eq("id", a.id);
      return ok("Beendet");
    })),

    // ── Preisalarm ─────────────────────────────────────────────────────────
    tool("create_price_watch", "Preisalarm: täglich prüfen und melden, wenn das Produkt unter den Zielpreis fällt.", {
      product: z.string().describe("möglichst genaue Produktbezeichnung"),
      target_euro: z.number().positive(),
      url: z.string().url().optional().describe("konkrete Produktseite, falls bekannt"),
    }, safe(async (a) => {
      requireAdult(ctx);
      const { error } = await db().from("price_watches").insert({ product: a.product, target_cents: Math.round(a.target_euro * 100), url: a.url ?? null, created_by: ctx.user.id });
      if (error) throw error;
      return ok(`Preisalarm für ${a.product} unter ${formatEuro(Math.round(a.target_euro * 100))} angelegt – wird täglich geprüft`);
    })),

    tool("list_price_watches", "Aktive Preisalarme mit zuletzt gefundenem Preis.", {}, safe(async () => {
      const { data, error } = await db().from("price_watches").select("id, product, target_cents, last_price_cents, last_shop, last_url, last_checked").eq("active", true);
      if (error) throw error;
      return ok(data ?? []);
    })),

    tool("stop_price_watch", "Preisalarm beenden.", { id: z.string().uuid() }, safe(async (a) => {
      requireAdult(ctx);
      await db().from("price_watches").update({ active: false }).eq("id", a.id);
      return ok("Preisalarm beendet");
    })),

    // ── Wunschlisten ───────────────────────────────────────────────────────
    tool("add_wish", "Wunsch auf eine Wunschliste setzen (z. B. für Geburtstag oder Weihnachten). Kinder dürfen auf ihre eigene Liste schreiben.", {
      for_person: z.string().optional().describe("Standard: die fragende Person"),
      item: z.string(), url: z.string().url().optional(), price_euro: z.number().nonnegative().optional(), occasion: z.string().optional(),
    }, safe(async (a) => {
      const target = a.for_person ? await findUser(a.for_person) : { id: ctx.user.id, name: ctx.user.name };
      if (ctx.user.role === "child" && target.id !== ctx.user.id) throw new Error("Kinder können nur auf ihre eigene Wunschliste schreiben");
      const { error } = await db().from("wishlist").insert({
        for_user: target.id, item: a.item, url: a.url ?? null, price_cents: a.price_euro == null ? null : Math.round(a.price_euro * 100),
        occasion: a.occasion ?? null, created_by: ctx.user.id,
      });
      if (error) throw error;
      return ok(`Auf ${target.name}s Wunschliste`);
    })),

    tool("list_wishes", "Wunschliste einer Person. Auf der eigenen Liste wird nicht verraten, was schon reserviert ist.", {
      person: z.string().optional(),
      occasion: z.string().optional(),
    }, safe(async (a) => {
      const target = a.person ? await findUser(a.person) : { id: ctx.user.id, name: ctx.user.name };
      if (ctx.user.role === "child" && target.id !== ctx.user.id) throw new Error("Keine Berechtigung");
      let q = db().from("wishlist").select("id, item, url, price_cents, occasion, reserved_by, done").eq("for_user", target.id).eq("done", false);
      if (a.occasion) q = q.ilike("occasion", a.occasion);
      const { data, error } = await q;
      if (error) throw error;
      const own = target.id === ctx.user.id;
      return ok((data ?? []).map((w) => (own ? { ...w, reserved_by: undefined } : { ...w, reserviert: Boolean(w.reserved_by) })));
    })),

    tool("reserve_wish", "Wunsch reservieren („kaufe ich“), damit nichts doppelt geschenkt wird.", { id: z.string().uuid() }, safe(async (a) => {
      requireAdult(ctx);
      const { data, error } = await db().from("wishlist").update({ reserved_by: ctx.user.id }).eq("id", a.id).is("reserved_by", null).neq("for_user", ctx.user.id).select("id");
      if (error) throw error;
      return ok(data?.length ? "Reserviert" : "Schon reserviert oder eigener Wunsch");
    })),

    tool("complete_wish", "Wunsch als erfüllt markieren.", { id: z.string().uuid() }, safe(async (a) => {
      requireAdult(ctx);
      await db().from("wishlist").update({ done: true }).eq("id", a.id);
      return ok("Erledigt");
    })),

    // ── Bestellung ─────────────────────────────────────────────────────────
    tool("request_order", "Bestellung zur Freigabe vorlegen (Stufe 2). Nach der Freigabe kommt der Warenkorb mit Links; abgeschlossen wird im Shop.", {
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
