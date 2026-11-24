import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ok, safe, type ToolContext } from "./context.js";

/**
 * Fernseher mit Couchpotato steuern. Kinder bekommen nur, was im Kinderprofil des Fernsehers
 * freigegeben ist – das prüft der Fernseher selbst (as_kid), der Hausgeist schickt es immer mit.
 */
export function tvTools(ctx: ToolContext) {
  const kid = ctx.user.role === "child";
  const tvArg = z.string().optional().describe("Name des Fernsehers, z. B. „Wohnzimmer“ – leer, wenn nur einer an ist");
  const send = async (name: string | undefined, cmd: string, args: Record<string, unknown> = {}, timeout?: number) => {
    const dev = ctx.tv.find(name);
    const r = await ctx.tv.send(dev, cmd, { ...args, as_kid: kid }, timeout);
    return { fernseher: dev.name, ...(typeof r === "object" && r ? r as object : { ergebnis: r }) };
  };

  return [
    tool("tv_list", "Gekoppelte Fernseher (Couchpotato) und ob sie gerade an sind.", {}, safe(async () => ok(ctx.tv.list().map((d) => ({ name: d.name, an: d.online, modell: d.model }))))),

    tool("tv_state", "Was gerade auf dem Fernseher läuft (Titel, Position, Pause, Live/Film/Serie, aktives Profil).", { tv: tvArg },
      safe(async (a) => ok(await send(a.tv, "state")))),

    tool("tv_search", `Inhalte suchen: eigene Mediathek (IPTV-Filme, -Serien, Live-Sender) und Streaming-Dienste mit installierter App.
Liefert Treffer mit kind/id – zum Abspielen an tv_play übergeben.`, {
      tv: tvArg,
      query: z.string().min(2).max(80),
    }, safe(async (a) => ok(await send(a.tv, "search", { query: a.query })))),

    tool("tv_play", `Abspielen auf dem Fernseher. kind/id aus tv_search.
- series: setzt dort fort, wo zuletzt geschaut wurde (sonst ab Folge 1)
- movie: Film (mit gespeicherter Position)
- live: Live-Sender`, {
      tv: tvArg,
      kind: z.enum(["movie", "series", "live"]),
      id: z.number().int(),
    }, safe(async (a) => ok(await send(a.tv, "play", { kind: a.kind, id: a.id }, 40_000)))),

    tool("tv_open_app", `App auf dem Fernseher öffnen (Netflix, Prime Video, YouTube, Disney+, ARD …), optional direkt mit Suchbegriff.
Ob die App den Suchbegriff übernimmt, hängt von der App ab – das Ergebnis sagt es.`, {
      tv: tvArg,
      app: z.string().min(2).max(40).describe("App-Name oder Paketname"),
      query: z.string().max(80).optional(),
    }, safe(async (a) => ok(await send(a.tv, "open_app", { app: a.app, query: a.query })))),

    tool("tv_show_search", "Suchergebnisse auf dem Bildschirm anzeigen – die Auswahl trifft man dann mit der Fernbedienung.", {
      tv: tvArg,
      query: z.string().min(2).max(80),
    }, safe(async (a) => ok(await send(a.tv, "show_search", { query: a.query })))),

    tool("tv_key", "Taste drücken: playpause, ok, back, home, up, down, left, right, volup, voldown, mute, ff, rew, chup, chdown.", {
      tv: tvArg,
      key: z.enum(["playpause", "ok", "back", "home", "up", "down", "left", "right", "volup", "voldown", "mute", "ff", "rew", "chup", "chdown"]),
      times: z.number().int().min(1).max(10).default(1),
    }, safe(async (a) => {
      let last: unknown;
      for (let i = 0; i < a.times; i++) last = await send(a.tv, "key", { k: a.key });
      return ok(last);
    })),

    tool("tv_message", "Kurze Nachricht auf dem Fernseher einblenden („Essen ist fertig!“).", {
      tv: tvArg,
      text: z.string().min(1).max(140),
    }, safe(async (a) => ok(await send(a.tv, "message", { text: `${a.text} – ${ctx.user.name}` })))),
  ];
}
