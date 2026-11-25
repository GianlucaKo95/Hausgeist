import { db } from "./db.js";
import type { Config } from "./config.js";
import type { AlpacaPaper } from "../adapters/alpaca.js";
import { runMiniAgent, parseJsonObject } from "./mini-agent.js";
import { activeRules, backtest, Rules } from "./intraday.js";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export async function profile(): Promise<{ goals: string; report_time: string }> {
  const { data } = await db().from("intraday_profile").select("goals, report_time").eq("id", 1).maybeSingle();
  return { goals: data?.goals ?? "", report_time: data?.report_time ?? "22:15" };
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

const SYSTEM = `Du bist der Strategie-Agent über einer Intraday-Engine (Alpaca PAPER-Konto, US-Aktien, kein echtes Geld).
Die Engine handelt mechanisch nach Regeln (JSON). Du entscheidest nie über einzelne Orders, sondern wertest abends aus und schlägst Regeländerungen vor.
Prüfe jede vorgeschlagene Änderung zuerst mit dem Werkzeug backtest (letzte 5–20 Handelstage) – nur vorschlagen, wenn sie dort nach Kosten besser ist als die aktive Regel, und ehrlich sagen, wenn nicht. Vorsicht vor Überanpassung an wenige Tage.
Achte auf die Wünsche des Nutzers. Long only, keine Hebel.
Antworte am Ende NUR mit JSON:
{"fazit":"5–10 Sätze Deutsch: Tagesergebnis in $ und % vs. SPY, welche Einstiege/Ausstiege gut/schlecht waren und warum, was der Backtest sagt",
 "vorschlag": null | {"rules": <vollständiges Regel-JSON>, "note": "was und warum geändert, mit Backtest-Zahlen alt vs. neu"}}`;

/** Abendauswertung nach US-Börsenschluss. */
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

  const btTool = tool("backtest", "Regel-JSON über vergangene 1-Minuten-Kerzen testen (IEX). days = Anzahl Kalendertage zurück (max. 30).", {
    rules: z.any(), days: z.number().int().min(1).max(30).default(10),
  }, async (a) => {
    const parsed = Rules.safeParse(a.rules);
    if (!parsed.success) return { content: [{ type: "text" as const, text: `Ungültige Regeln: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }] };
    const bars = await alpaca.bars(parsed.data.symbols, new Date(Date.now() - a.days * 86_400_000).toISOString());
    return { content: [{ type: "text" as const, text: JSON.stringify(await backtest(parsed.data, bars)) }] };
  });

  const prompt = `Handelstag ${day} (New York).
Wünsche des Nutzers: ${prof.goals || "(noch keine – frag im Fazit nach seinen Vorlieben)"}
Aktive Regeln (Version ${active?.version ?? "–"}): ${JSON.stringify(active?.rules ?? null)}
Konto: Wert ${Number(acct.equity).toFixed(2)} $, heute ${pnlDay >= 0 ? "+" : ""}${pnlDay.toFixed(2)} $. SPY heute: ${spyPct ?? "?"} %.
Realisiert heute: ${r.total} $ in ${r.roundTrips} Verkäufen, je Wert ${JSON.stringify(r.per)}
Engine-Protokoll mit Begründungen: ${JSON.stringify(log ?? [])}
Letzte Fazits: ${JSON.stringify((last ?? []).map((x) => ({ tag: x.day, pnl: x.pnl_usd, fazit: String(x.summary).slice(0, 300) })))}`;

  const raw = await runMiniAgent(config, { system: SYSTEM, prompt, tools: [btTool as never], web: false, maxTurns: 20, label: "intraday-fazit" });
  const out = parseJsonObject<{ fazit?: string; vorschlag?: { rules: unknown; note?: string } | null }>(raw);
  if (!out?.fazit) throw new Error("Strategie-Agent lieferte kein auswertbares Fazit");

  let proposalVersion: number | null = null;
  if (out.vorschlag?.rules) {
    const p = Rules.safeParse(out.vorschlag.rules);
    if (p.success) {
      const { data: top } = await db().from("intraday_rules").select("version").order("version", { ascending: false }).limit(1).maybeSingle();
      proposalVersion = (top?.version ?? 0) + 1;
      await db().from("intraday_rules").update({ status: "archived" }).eq("status", "proposed");
      await db().from("intraday_rules").insert({ version: proposalVersion, rules: p.data, note: out.vorschlag.note ?? null, status: "proposed", created_by: "agent" });
    }
  }
  const text = [
    `Intraday ${day}: ${pnlDay >= 0 ? "+" : ""}${pnlDay.toFixed(2)} $ · SPY ${spyPct ?? "?"} % · ${(log ?? []).filter((x) => x.side === "buy").length} Einstiege`,
    out.fazit,
    proposalVersion ? `Vorschlag Version ${proposalVersion}: ${out.vorschlag?.note ?? ""}\nÜbernehmen? Sag „Übernimm den Intraday-Vorschlag“.` : "",
    "(Paper-Trading – kein echtes Geld.)",
  ].filter(Boolean).join("\n\n");

  await db().from("intraday_reports").upsert({
    day, equity_usd: Number(acct.equity), pnl_usd: Math.round(pnlDay * 100) / 100, spy_pct: spyPct,
    trades: (log ?? []).filter((x) => x.side === "buy").length, summary: text, proposal_version: proposalVersion,
  });
  return text;
}
