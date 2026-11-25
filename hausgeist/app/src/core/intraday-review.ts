import { db } from "./db.js";
import type { Config } from "./config.js";
import type { AlpacaPaper } from "../adapters/alpaca.js";
import { runMiniAgent, parseJsonObject } from "./mini-agent.js";
import { activeRules, backtest, Rules } from "./intraday.js";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export interface IntradayProfile { goals: string; report_time: string; lessons: string; autopilot: boolean }

export async function profile(): Promise<IntradayProfile> {
  const { data } = await db().from("intraday_profile").select("goals, report_time, lessons, autopilot").eq("id", 1).maybeSingle();
  return { goals: data?.goals ?? "", report_time: data?.report_time ?? "22:15", lessons: data?.lessons ?? "", autopilot: data?.autopilot ?? true };
}

/** Realisierte Gewinne je Wert aus den Ausführungen (FIFO). */
export function realized(fills: { symbol: string; side: string; qty: string; price: string }[]): { total: number; per: Record<string, number>; roundTrips: number } {
  const lots: Record<string, { qty: number; price: number }[]> = {};
  const per: Record<string, number> = {};
  let total = 0, roundTrips = 0;
  for (const f of fills) {
    const q = Number(f.qty), p = Number(f.price);
    if (f.side === "buy") { (lots[f.symbol] ??= []).push({ qty: q, price: p }); continue; }
    let rest = q;
    const l = lots[f.symbol] ?? [];
    while (rest > 1e-9 && l.length) {
      const take = Math.min(rest, l[0].qty);
      const pnl = take * (p - l[0].price);
      per[f.symbol] = (per[f.symbol] ?? 0) + pnl; total += pnl;
      l[0].qty -= take; rest -= take;
      if (l[0].qty <= 1e-9) l.shift();
    }
    roundTrips++;
  }
  return { total: Math.round(total * 100) / 100, per, roundTrips };
}

const RULE_FORMAT = `Regel-JSON: {symbols:["AAPL",…] (max 20), timeframe:1|5|10,
entry:[{left:Expr, op:">"|"<"|"cross_above"|"cross_below", right:Expr}] (alle müssen gelten, nur Long),
exit:{stop_loss_pct, take_profit_pct?, trailing_stop_pct?, max_hold_min?, conditions:[…] (eine genügt)},
sizing:{usd_per_trade, max_positions}, risk:{max_daily_loss_usd, max_trades_per_day?, no_entry_first_min?, flat_before_close_min?, cooldown_min?}}
Expr: {ind:"close"|"open"|"high"|"low"|"volume"} | {ind:"sma"|"ema", period, of?:"close"|"volume"} | {ind:"rsi", period} | {ind:"vwap"} | {ind:"highest"|"lowest", period} (vorherige Kerzen) | {ind:"value", value}; jedes Expr optional mit mult.`;

const AUTOPILOT = `Du bist ein eigenständiger Strategie-Entwickler für Intraday-Trading auf einem Alpaca-PAPER-Konto (Spielgeld, US-Aktien).
Du arbeitest selbstständig: Du entwirfst Strategien, lässt sie einen echten Handelstag lang von der Engine handeln, ziehst daraus selbst Schlüsse und entwickelst sie weiter. Der Nutzer gibt nur Richtung und Geschmack vor – die Strategie kommt von dir.
Vorgehen:
- Nutze backtest, um Ideen vorab auf den letzten 5–15 Handelstagen zu prüfen – aber entscheide selbst. Ein Backtest ist kein Beweis, der echte Tag zählt.
- Ändere pro Tag gezielt 1–3 Dinge, damit du lernst, was wirkt (nicht alles auf einmal umwerfen – außer die Strategie ist klar gescheitert).
- Halte Erkenntnisse fest, die über den Tag hinaus gelten (Lehren), und streiche widerlegte.
- Nicht immer handeln wollen: Wenig Trades mit Vorteil schlagen viele ohne. Kosten (Spread, Schlupf) einrechnen.
- Grenzen: max. 20 Werte, Stop-Loss immer gesetzt. Die Budget- und Risikogrenzen aus den Wünschen des Nutzers (Trade-Größe, Tagesverlust) sind verbindlich; ohne solche Angaben höchstens 2 % des Kontos Tagesverlust.
${RULE_FORMAT}`;

function backtestTool(alpaca: AlpacaPaper) {
  return tool("backtest", "Regel-JSON über vergangene 1-Minuten-Kerzen testen (IEX). days = Kalendertage zurück (max. 30).", {
    rules: z.any(), days: z.number().int().min(1).max(30).default(10),
  }, async (a) => {
    const parsed = Rules.safeParse(a.rules);
    if (!parsed.success) return { content: [{ type: "text" as const, text: `Ungültige Regeln: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }] };
    const bars = await alpaca.bars(parsed.data.symbols, new Date(Date.now() - a.days * 86_400_000).toISOString());
    return { content: [{ type: "text" as const, text: JSON.stringify(await backtest(parsed.data, bars)) }] };
  });
}

/** Neue Regel-Version speichern; im Autopilot sofort aktiv (nur Papier). */
async function storeRules(rules: unknown, note: string, activate: boolean): Promise<number | null> {
  const p = Rules.safeParse(rules);
  if (!p.success) return null;
  const { data: top } = await db().from("intraday_rules").select("version").order("version", { ascending: false }).limit(1).maybeSingle();
  const version = (top?.version ?? 0) + 1;
  if (activate) await db().from("intraday_rules").update({ status: "archived" }).in("status", ["active", "proposed"]);
  else await db().from("intraday_rules").update({ status: "archived" }).eq("status", "proposed");
  await db().from("intraday_rules").insert({ version, rules: p.data, note, status: activate ? "active" : "proposed", created_by: "agent", activated_at: activate ? new Date().toISOString() : null });
  return version;
}

/**
 * Morgens vor US-Börsenstart: Gibt es keine aktive Strategie, entwirft der Agent selbst eine.
 * Rückgabe: Text für die Push-Nachricht (oder null).
 */
export async function designStrategy(config: Config, alpaca: AlpacaPaper, force = false): Promise<string | null> {
  const prof = await profile();
  const active = await activeRules();
  if (active && !force) return null;
  const acct = await alpaca.account();
  const prompt = `Entwirf die Strategie für den heutigen Handelstag.
Wünsche/Geschmack des Nutzers: ${prof.goals || "(keine – wähle selbst etwas Sinnvolles, z. B. liquide Tech-Werte)"}
Bisherige Lehren: ${prof.lessons || "(noch keine)"}
${active ? `Aktive Strategie (Version ${active.version}): ${JSON.stringify(active.rules)}` : "Noch keine aktive Strategie."}
Konto: ${Number(acct.equity).toFixed(0)} $ Spielgeld.
Prüfe 1–3 Varianten mit backtest und wähle eine. Antworte am Ende NUR mit JSON:
{"rules": <vollständiges Regel-JSON>, "idee": "2–4 Sätze: was die Strategie macht und warum du sie heute testest", "lehren": "aktualisierte Liste deiner Lehren (Stichpunkte, max. 15)"}`;
  const raw = await runMiniAgent(config, { system: AUTOPILOT, prompt, tools: [backtestTool(alpaca) as never], maxTurns: 25, label: "intraday-entwurf", light: false });
  const out = parseJsonObject<{ rules?: unknown; idee?: string; lehren?: string }>(raw);
  if (!out?.rules) throw new Error("Strategie-Agent lieferte keine Regeln");
  const v = await storeRules(out.rules, out.idee ?? "Erster Entwurf", prof.autopilot);
  if (!v) throw new Error("Vom Agenten entworfene Regeln waren ungültig");
  if (out.lehren) await db().from("intraday_profile").update({ lessons: out.lehren.slice(0, 4000), updated_at: new Date().toISOString() }).eq("id", 1);
  return prof.autopilot
    ? `Neue Strategie (Version ${v}) ist für heute aktiv:\n${out.idee ?? ""}`
    : `Strategie-Vorschlag Version ${v}:\n${out.idee ?? ""}\nÜbernehmen? „Übernimm den Intraday-Vorschlag“.`;
}

/** Abends nach US-Börsenschluss: auswerten, Lehren ziehen, Strategie selbst anpassen. */
export async function reviewDay(config: Config, alpaca: AlpacaPaper, day: string): Promise<string | null> {
  const active = await activeRules();
  const fills = await alpaca.fills(day).catch(() => []);
  const { data: log } = await db().from("intraday_trades").select("at, symbol, side, reason, price").gte("at", `${day}T00:00:00Z`).lte("at", `${day}T23:59:59Z`).order("at");
  if (!active && !fills.length) return null;
  const acct = await alpaca.account();
  const pnlDay = Number(acct.equity) - Number(acct.last_equity);
  const spy = await alpaca.bars(["SPY"], new Date(Date.parse(day) - 6 * 86_400_000).toISOString(), "1Day").catch(() => ({} as Record<string, { c: number; t: string }[]>));
  const s = spy.SPY ?? [];
  const spyPct = s.length >= 2 ? Math.round((s[s.length - 1].c / s[s.length - 2].c - 1) * 10_000) / 100 : null;
  // Kein Handelstag (Wochenende/Feiertag): keine SPY-Tageskerze für heute
  const lastDay = s.length ? new Date(s[s.length - 1].t).toLocaleDateString("sv-SE", { timeZone: "America/New_York" }) : null;
  if (lastDay !== day && !fills.length) return null;
  const r = realized(fills);
  const prof = await profile();
  const { data: last } = await db().from("intraday_reports").select("day, pnl_usd, summary").order("day", { ascending: false }).limit(5);
  const entries = (log ?? []).filter((x) => x.side === "buy").length;

  const prompt = `Handelstag ${day} (New York) ist vorbei. Werte ihn aus und entwickle die Strategie weiter.
Wünsche des Nutzers: ${prof.goals || "(keine besonderen)"}
Bisherige Lehren: ${prof.lessons || "(noch keine)"}
Heute aktive Strategie (Version ${active?.version ?? "–"}): ${JSON.stringify(active?.rules ?? null)}
Konto: ${Number(acct.equity).toFixed(2)} $, heute ${pnlDay >= 0 ? "+" : ""}${pnlDay.toFixed(2)} $. SPY heute: ${spyPct ?? "?"} %.
Realisiert: ${r.total} $ in ${r.roundTrips} Verkäufen, je Wert ${JSON.stringify(r.per)}
Einstiege heute: ${entries}. Engine-Protokoll mit Begründungen: ${JSON.stringify(log ?? [])}
Letzte Tage: ${JSON.stringify((last ?? []).map((x) => ({ tag: x.day, pnl: x.pnl_usd, fazit: String(x.summary).slice(0, 300) })))}
${entries === 0 ? "Hinweis: Heute gab es KEINEN Einstieg – die Bedingungen sind vermutlich zu streng oder passen nicht zum Markt. Das ist auch ein Ergebnis; ändere etwas, damit morgen gelernt werden kann." : ""}
Antworte am Ende NUR mit JSON:
{"fazit": "3–5 Sätze: Ergebnis in $ und vs. SPY, was funktioniert hat und was nicht, und WARUM",
 "aenderungen": "1–3 konkrete Änderungen für morgen mit Begründung (oder ausdrücklich: keine Änderung, weil …)",
 "rules": <vollständiges Regel-JSON für morgen>,
 "lehren": "aktualisierte Liste deiner Lehren (Stichpunkte, max. 15)"}`;

  const raw = await runMiniAgent(config, { system: AUTOPILOT, prompt, tools: [backtestTool(alpaca) as never], maxTurns: 20, label: "intraday-fazit", light: false });
  const out = parseJsonObject<{ fazit?: string; aenderungen?: string; rules?: unknown; lehren?: string }>(raw);
  if (!out?.fazit) throw new Error("Strategie-Agent lieferte kein auswertbares Fazit");

  let version: number | null = null;
  if (out.rules && JSON.stringify(out.rules) !== JSON.stringify(active?.rules)) {
    version = await storeRules(out.rules, out.aenderungen ?? "", prof.autopilot);
  }
  if (out.lehren) await db().from("intraday_profile").update({ lessons: out.lehren.slice(0, 4000), updated_at: new Date().toISOString() }).eq("id", 1);

  const text = [
    `Intraday ${day}: ${pnlDay >= 0 ? "+" : ""}${pnlDay.toFixed(2)} $ · SPY ${spyPct ?? "?"} % · ${entries} Einstiege`,
    out.fazit,
    version
      ? (prof.autopilot ? `Ich ändere für morgen (Version ${version}): ${out.aenderungen ?? ""}` : `Vorschlag Version ${version}: ${out.aenderungen ?? ""}\nÜbernehmen? „Übernimm den Intraday-Vorschlag“.`)
      : `Keine Änderung: ${out.aenderungen ?? "die Strategie bleibt so."}`,
    "(Paper-Trading – kein echtes Geld.)",
  ].filter(Boolean).join("\n\n");

  await db().from("intraday_reports").upsert({
    day, equity_usd: Number(acct.equity), pnl_usd: Math.round(pnlDay * 100) / 100, spy_pct: spyPct,
    trades: entries, summary: text, proposal_version: version,
  });
  return text;
}
