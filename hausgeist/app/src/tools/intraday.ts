import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { db } from "../core/db.js";
import { activeRules, backtest, describe, Rules, type ExprT, type RulesT } from "../core/intraday.js";
import { designStrategy, profile, reviewDay } from "../core/intraday-review.js";
import { ok, requireAdmin, safe, type ToolContext } from "./context.js";

function words(r: RulesT): string {
  const c = (x: { left: unknown; op: string; right: unknown }) => `${describe(x.left as ExprT)} ${x.op} ${describe(x.right as ExprT)}`;
  return `${r.symbols.join(", ")} · ${r.timeframe}-Min.-Kerzen · Einstieg wenn ${r.entry.map(c).join(" UND ")} · Stop ${r.exit.stop_loss_pct} %${r.exit.take_profit_pct ? `, Ziel ${r.exit.take_profit_pct} %` : ""}${r.exit.trailing_stop_pct ? `, Trailing ${r.exit.trailing_stop_pct} %` : ""}${r.exit.max_hold_min ? `, max. ${r.exit.max_hold_min} Min.` : ""}${r.exit.conditions.length ? `, Ausstieg wenn ${r.exit.conditions.map(c).join(" ODER ")}` : ""} · ${r.sizing.usd_per_trade} $ je Trade, max. ${r.sizing.max_positions} Positionen · Tagesverlust-Grenze ${r.risk.max_daily_loss_usd} $`;
}

const RULE_HELP = `Regel-JSON: {symbols:["AAPL",…], timeframe:1|5|10,
entry:[{left:Expr, op:">"|"<"|"cross_above"|"cross_below", right:Expr}] (alle müssen gelten),
exit:{stop_loss_pct, take_profit_pct?, trailing_stop_pct?, max_hold_min?, conditions:[…] (eine genügt)},
sizing:{usd_per_trade, max_positions}, risk:{max_daily_loss_usd, max_trades_per_day?, no_entry_first_min?, flat_before_close_min?, cooldown_min?}}
Expr: {ind:"close"|"open"|"high"|"low"|"volume"} | {ind:"sma"|"ema", period, of?:"close"|"volume"} | {ind:"rsi", period} | {ind:"vwap"} | {ind:"highest"|"lowest", period} (vorherige Kerzen) | {ind:"value", value}; jedes Expr optional mit mult (z. B. Volumen > 1,5 × SMA20 Volumen).`;

/** Intraday-Engine (Alpaca Paper) – nur Admin. */
export function intradayTools(ctx: ToolContext) {
  const { alpaca, intraday } = ctx;
  return [
    tool("intraday_status", "Intraday-Engine: läuft sie, Konto (Paper), offene Positionen, aktive Regel in Worten, offener Vorschlag.", {}, safe(async () => {
      requireAdmin(ctx);
      const active = await activeRules();
      const { data: prop } = await db().from("intraday_rules").select("version, note, rules").eq("status", "proposed").maybeSingle();
      const acct = alpaca.enabled ? await alpaca.account() : null;
      const pos = alpaca.enabled ? await alpaca.positions() : [];
      const clock = alpaca.enabled ? await alpaca.clock() : null;
      return ok({
        engine: intraday.status(), markt_offen: clock?.is_open ?? null, naechste_eroeffnung: clock?.next_open,
        konto: acct ? { wert_usd: Number(acct.equity), heute_usd: Math.round((Number(acct.equity) - Number(acct.last_equity)) * 100) / 100, bargeld_usd: Number(acct.cash) } : "Alpaca nicht eingerichtet",
        positionen: pos.map((p) => ({ symbol: p.symbol, stueck: Number(p.qty), einstand: Number(p.avg_entry_price), kurs: Number(p.current_price), gv_usd: Number(p.unrealized_pl) })),
        aktive_regel: active ? { version: active.version, in_worten: words(active.rules) } : "keine – Engine handelt nicht",
        vorschlag: prop ? { version: prop.version, notiz: prop.note, in_worten: Rules.safeParse(prop.rules).success ? words(Rules.parse(prop.rules)) : "?" } : null,
        wuensche: (await profile()).goals,
        autopilot: (await profile()).autopilot,
      });
    })),

    tool("intraday_set_rules", `Neue Regeln speichern (auf Wunsch des Nutzers). activate=true nur, wenn der Nutzer die Regel ausdrücklich scharf schalten will. Vorher backtest laufen lassen und Ergebnis nennen.\n${RULE_HELP}`, {
      rules: z.any(), note: z.string().max(500), activate: z.boolean().default(false),
    }, safe(async (a) => {
      requireAdmin(ctx);
      const p = Rules.safeParse(a.rules);
      if (!p.success) throw new Error(`Regeln ungültig: ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      const { data: top } = await db().from("intraday_rules").select("version").order("version", { ascending: false }).limit(1).maybeSingle();
      const version = (top?.version ?? 0) + 1;
      if (a.activate) await db().from("intraday_rules").update({ status: "archived" }).in("status", ["active", "proposed"]);
      await db().from("intraday_rules").insert({ version, rules: p.data, note: a.note, status: a.activate ? "active" : "proposed", created_by: "user", activated_at: a.activate ? new Date().toISOString() : null });
      return ok(`Version ${version} ${a.activate ? "aktiv – gilt ab der nächsten Kerze" : "als Vorschlag gespeichert"}: ${words(p.data)}`);
    })),

    tool("intraday_decide_proposal", "Offenen Regel-Vorschlag übernehmen (aktiv schalten) oder verwerfen.", {
      accept: z.boolean(),
    }, safe(async (a) => {
      requireAdmin(ctx);
      const { data: prop } = await db().from("intraday_rules").select("version, rules").eq("status", "proposed").maybeSingle();
      if (!prop) throw new Error("Es gibt keinen offenen Vorschlag");
      if (!a.accept) { await db().from("intraday_rules").update({ status: "rejected" }).eq("version", prop.version); return ok(`Vorschlag ${prop.version} verworfen – die aktive Regel bleibt.`); }
      await db().from("intraday_rules").update({ status: "archived" }).eq("status", "active");
      await db().from("intraday_rules").update({ status: "active", activated_at: new Date().toISOString() }).eq("version", prop.version);
      return ok(`Version ${prop.version} ist aktiv: ${words(Rules.parse(prop.rules))}`);
    })),

    tool("intraday_backtest", `Regeln über vergangene 1-Minuten-Kerzen testen (Paper, IEX). Ohne rules = aktive Regel.\n${RULE_HELP}`, {
      rules: z.any().optional(), days: z.number().int().min(1).max(30).default(10),
    }, safe(async (a) => {
      requireAdmin(ctx);
      const r = a.rules ? Rules.parse(a.rules) : (await activeRules())?.rules;
      if (!r) throw new Error("Keine Regeln angegeben und keine aktive Regel");
      const bars = await alpaca.bars(r.symbols, new Date(Date.now() - a.days * 86_400_000).toISOString());
      return ok({ zeitraum_tage: a.days, regel: words(r), ergebnis: await backtest(r, bars), hinweis: "Vergangene Kerzen, 0,05 % Schlupf je Seite, Positionen je Wert unabhängig gerechnet – kein Versprechen für die Zukunft." });
    })),

    tool("intraday_goals", "Wünsche/Geschmack des Nutzers für die Intraday-Strategie speichern (vollständiger Text) und/oder Uhrzeit des Abendfazits.", {
      goals: z.string().max(3000).optional(), report_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    }, safe(async (a) => {
      requireAdmin(ctx);
      const cur = await profile();
      await db().from("intraday_profile").upsert({ id: 1, goals: a.goals ?? cur.goals, report_time: a.report_time ?? cur.report_time, updated_at: new Date().toISOString() });
      return ok("Gespeichert.");
    })),

    tool("intraday_autopilot", "Autopilot an/aus: Der Strategie-Agent entwirft selbst Strategien, testet sie je einen Handelstag auf dem Paper-Konto und passt sie abends selbst an (nur Spielgeld). Aus = er macht nur Vorschläge.", {
      on: z.boolean(),
    }, safe(async (a) => {
      requireAdmin(ctx);
      await db().from("intraday_profile").upsert({ id: 1, autopilot: a.on, updated_at: new Date().toISOString() });
      return ok(a.on ? "Autopilot an – der Strategie-Agent entwickelt und testet selbstständig." : "Autopilot aus – Änderungen kommen nur noch als Vorschlag.");
    })),

    tool("intraday_design_now", "Strategie-Agent soll JETZT selbst eine (neue) Strategie entwerfen und – im Autopilot – sofort aktiv schalten. Für „Leg los“, „Denk dir was aus“, „Probier was Neues“.", {}, safe(async () => {
      requireAdmin(ctx);
      return ok(await designStrategy(ctx.config, alpaca, true) ?? "Keine Strategie entworfen.");
    })),

    tool("intraday_lessons", "Was der Strategie-Agent bisher gelernt hat (seine Lehren).", {}, safe(async () => {
      requireAdmin(ctx);
      const p = await profile();
      return ok({ lehren: p.lessons || "noch keine", autopilot: p.autopilot, wuensche: p.goals });
    })),

    tool("intraday_engine", "Engine pausieren/fortsetzen oder sofort alle Positionen glattstellen (Paper).", {
      action: z.enum(["pause", "resume", "close_all"]),
    }, safe(async (a) => {
      requireAdmin(ctx);
      if (a.action === "pause") intraday.enabled = false;
      if (a.action === "resume") intraday.enabled = true;
      if (a.action === "close_all") { await alpaca.closeAll(); intraday.enabled = false; return ok("Alle Paper-Positionen geschlossen, Engine pausiert."); }
      return ok(intraday.status());
    })),

    tool("intraday_trades", "Engine-Protokoll mit Begründungen.", { day: z.string().optional().describe("JJJJ-MM-TT, Standard heute"), limit: z.number().int().max(200).default(50) }, safe(async (a) => {
      requireAdmin(ctx);
      let q = db().from("intraday_trades").select("at, symbol, side, notional_usd, qty, price, reason, rule_version").order("at", { ascending: false }).limit(a.limit);
      if (a.day) q = q.gte("at", `${a.day}T00:00:00Z`).lte("at", `${a.day}T23:59:59Z`);
      const { data } = await q;
      return ok(data ?? []);
    })),

    tool("intraday_reports", "Frühere Intraday-Abendfazits.", { limit: z.number().int().max(30).default(5) }, safe(async (a) => {
      requireAdmin(ctx);
      const { data } = await db().from("intraday_reports").select("day, pnl_usd, spy_pct, trades, summary").order("day", { ascending: false }).limit(a.limit);
      return ok(data ?? []);
    })),

    tool("intraday_review_now", "Abendauswertung jetzt laufen lassen (für einen Handelstag).", { day: z.string().optional() }, safe(async (a) => {
      requireAdmin(ctx);
      const day = a.day ?? new Date().toLocaleDateString("sv-SE", { timeZone: "America/New_York" });
      return ok(await reviewDay(ctx.config, alpaca, day) ?? "Nichts auszuwerten (keine Regel, keine Trades).");
    })),
  ];
}
