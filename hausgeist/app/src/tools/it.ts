import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { db } from "../core/db.js";
import { ok, safe, requireAdmin, type ToolContext } from "./context.js";

/** IT-Agent: FRITZ!Box (TR-064) und Windows-PC (SSH). Nur für den Admin. */
export function itTools(ctx: ToolContext) {
  const pcName = () => ctx.config.pc.name || "PC";
  return [
    tool("fritz_status", "FRITZ!Box: Modell, Firmware, Internetverbindung, aktuelle Auslastung, externe IP.", {}, safe(async () => {
      requireAdmin(ctx);
      return ok(await ctx.fritz.status());
    })),

    tool("fritz_devices", "Geräte im Heimnetz (Name, IP, MAC, WLAN/LAN).", {
      only_active: z.boolean().default(true),
    }, safe(async (a) => {
      requireAdmin(ctx);
      return ok(await ctx.fritz.hosts(a.only_active));
    })),

    tool("fritz_guest_wifi", "Gast-WLAN: Status, Name und Passwort (mit QR-Text); optional ein- oder ausschalten (Stufe 1).", {
      set_enabled: z.boolean().optional(),
    }, safe(async (a) => {
      requireAdmin(ctx);
      if (a.set_enabled !== undefined) await ctx.fritz.setGuestWifi(a.set_enabled);
      return ok(await ctx.fritz.guestWifi());
    })),

    tool("fritz_calls", "Anrufliste der FRITZ!Box (eingehend, verpasst, ausgehend).", {
      days: z.number().int().min(1).max(30).default(3),
      only_missed: z.boolean().default(false),
    }, safe(async (a) => {
      requireAdmin(ctx);
      const calls = await ctx.fritz.calls(a.days);
      return ok(a.only_missed ? calls.filter((c) => c.type === "verpasst") : calls);
    })),

    tool("request_fritz_reboot", "FRITZ!Box-Neustart zur Freigabe vorlegen (Stufe 2) – Internet ist danach ein paar Minuten weg.", {
      reason: z.string(),
    }, safe(async (a) => {
      requireAdmin(ctx);
      const r = await ctx.actions.request("fritz_reboot", {}, { agent: "it", summary: `FRITZ!Box neu starten: ${a.reason}`, requestedBy: ctx.user });
      return ok(`Zur Freigabe vorgelegt (${r.id}).`);
    })),

    tool("pc_online", "Ist der Windows-PC an und erreichbar?", {}, safe(async () => {
      requireAdmin(ctx);
      if (!ctx.pc.enabled) return ok("Der PC ist noch nicht eingerichtet (App → Verwaltung → Netzwerk & PC).");
      return ok({ pc: pcName(), online: await ctx.pc.online() });
    })),

    tool("pc_wake", "Windows-PC über die FRITZ!Box einschalten (Wake-on-LAN, Stufe 1).", {}, safe(async () => {
      requireAdmin(ctx);
      if (!ctx.config.pc.mac) throw new Error("Für den PC ist keine MAC-Adresse hinterlegt.");
      await ctx.fritz.wake(ctx.config.pc.mac);
      return ok(`Weckruf an ${pcName()} gesendet – meist ist er nach 30–90 Sekunden erreichbar (pc_online prüfen).`);
    })),

    tool("request_pc_command", `PowerShell-Befehl am Windows-PC zur Freigabe vorlegen (Stufe 2). Ausgeführt wird erst nach Klick des Admins, genau dieser Befehl.
Programme installieren/aktualisieren mit winget, z. B.:
  winget install --id Mozilla.Firefox -e --silent --accept-source-agreements --accept-package-agreements
  winget upgrade --all --silent --accept-source-agreements --accept-package-agreements
Programm-ID vorher ermitteln: winget search <Name> (ebenfalls als Befehl zur Freigabe).
Die Ausgabe holst du nach der Ausführung mit pc_command_result.`, {
      command: z.string().min(1).max(4000).describe("PowerShell-Befehl"),
      purpose: z.string().min(3).max(200).describe("Kurz und verständlich, wofür – wird dem Admin angezeigt"),
      timeout_min: z.number().int().min(1).max(60).default(15),
    }, safe(async (a) => {
      requireAdmin(ctx);
      if (!ctx.pc.enabled) throw new Error("Der PC ist noch nicht eingerichtet (App → Verwaltung → Netzwerk & PC).");
      const summary = `${pcName()}: ${a.purpose}\n\n${a.command.length > 600 ? `${a.command.slice(0, 600)}…` : a.command}`;
      const r = await ctx.actions.request("pc_command", { command: a.command, purpose: a.purpose, timeout_min: a.timeout_min },
        { agent: "it", summary, requestedBy: ctx.user });
      return ok(`Zur Freigabe vorgelegt (${r.id}). Läuft erst nach Klick des Admins.`);
    })),

    tool("pc_command_result", "Status und Ausgabe eines freigegebenen PC-Befehls.", {
      id: z.string().uuid(),
    }, safe(async (a) => {
      requireAdmin(ctx);
      const { data } = await db().from("actions").select("status, result, summary, created_at").eq("id", a.id).eq("kind", "pc_command").maybeSingle();
      if (!data) throw new Error("Befehl nicht gefunden");
      return ok(data);
    })),
  ];
}
