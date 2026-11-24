import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { db } from "../core/db.js";
import { ok, safe, requireAdmin, type ToolContext } from "./context.js";
import { discoverComputers, portOpen } from "../adapters/pc.js";

/** IT-Agent: FRITZ!Box (TR-064) und Windows-PC (SSH). Nur für den Admin. */
export function itTools(ctx: ToolContext) {
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

    tool("list_computers", "Eingerichtete Computer mit Name, Adresse und ob sie gerade an sind.", {}, safe(async () => {
      requireAdmin(ctx);
      const pcs = ctx.pc.list();
      if (!pcs.length) return ok("Noch kein Computer eingerichtet – mit discover_computers im Heimnetz suchen.");
      return ok(await Promise.all(pcs.map(async (p) => ({ name: p.name, host: p.host, user: p.user, mac: p.mac || null, online: await ctx.pc.online(p) }))));
    })),

    tool("discover_computers", "Computer im Heimnetz über die FRITZ!Box finden (auch ausgeschaltete) und prüfen, ob sie schon für den Hausgeist erreichbar sind.", {}, safe(async () => {
      requireAdmin(ctx);
      const found = await discoverComputers(await ctx.fritz.hosts(false), ctx.pc.list());
      const out = found.map((c) => ({
        name: c.name, ip: c.ip, mac: c.mac, an: c.active, verbindung: c.connection,
        windows_wahrscheinlich: c.windows, ssh_bereit: c.ssh, eingerichtet_als: c.configuredAs,
        naechster_schritt: c.configuredAs ? "fertig" : !c.active ? "einschalten, dann erneut suchen" : c.ssh ? "mit add_computer hinzufügen" : "Einrichtungsbefehl aus der App am Computer ausführen",
      }));
      return ok(out);
    })),

    tool("add_computer", "Gefundenen Computer unter einem Namen (z. B. „PC“, „Laptop“) einrichten. Danach in der App „Testen“ oder pc_online.", {
      name: z.string().min(1).max(40),
      host: z.string().min(1).describe("IP oder Gerätename aus discover_computers"),
      mac: z.string().optional(),
      user: z.string().optional().describe("Windows-Benutzername; ohne Angabe wie beim ersten Computer"),
    }, safe(async (a) => {
      requireAdmin(ctx);
      const pcs = ctx.pc.list();
      const user = a.user || pcs[0]?.user;
      if (!user) throw new Error("Bitte den Windows-Benutzernamen angeben.");
      const entry = { name: a.name, host: a.host, port: 22, user, mac: (a.mac ?? "").replace(/-/g, ":").toUpperCase() };
      const next = [...pcs.filter((p) => p.name.toLowerCase() !== a.name.toLowerCase() && p.host !== a.host), entry];
      await ctx.saveSettings({ pcs: next });
      return ok({ eingerichtet: entry, ssh_bereit: await portOpen(a.host, 22, 1500) });
    })),

    tool("pc_online", "Ist ein Computer an und erreichbar?", {
      computer: z.string().optional().describe("Name, z. B. „Laptop“; ohne Angabe bei nur einem Computer"),
    }, safe(async (a) => {
      requireAdmin(ctx);
      const pc = ctx.pc.find(a.computer);
      return ok({ computer: pc.name, online: await ctx.pc.online(pc) });
    })),

    tool("pc_wake", "Computer über die FRITZ!Box einschalten (Wake-on-LAN, Stufe 1).", {
      computer: z.string().optional(),
    }, safe(async (a) => {
      requireAdmin(ctx);
      const pc = ctx.pc.find(a.computer);
      if (!pc.mac) throw new Error(`Für ${pc.name} ist keine MAC-Adresse hinterlegt.`);
      await ctx.fritz.wake(pc.mac);
      return ok(`Weckruf an ${pc.name} gesendet – meist nach 30–90 Sekunden erreichbar (pc_online prüfen). Laptops wachen per WLAN oft nicht auf.`);
    })),

    tool("request_pc_command", `PowerShell-Befehl an einem Computer zur Freigabe vorlegen (Stufe 2). Ausgeführt wird erst nach Klick des Admins, genau dieser Befehl.
Programme installieren/aktualisieren mit winget, z. B.:
  winget install --id Mozilla.Firefox -e --silent --accept-source-agreements --accept-package-agreements
  winget upgrade --all --silent --accept-source-agreements --accept-package-agreements
Programm-ID vorher ermitteln: winget search <Name> (ebenfalls als Befehl zur Freigabe).
Alles, was der Benutzer SEHEN soll (Website öffnen, Programm starten, Datei anzeigen), mit on_desktop: true –
sonst läuft es unsichtbar im Hintergrund. Baue dafür KEINE eigenen geplanten Aufgaben – on_desktop erledigt das. Website öffnen z. B.: Start-Process "https://www.example.de"
Die Ausgabe holst du nach der Ausführung mit pc_command_result.`, {
      on_desktop: z.boolean().default(false).describe("true = auf dem Bildschirm des angemeldeten Benutzers ausführen (Fenster, Browser)"),
      computer: z.string().optional().describe("Name des Computers, z. B. „Laptop“"),
      command: z.string().min(1).max(4000).describe("PowerShell-Befehl"),
      purpose: z.string().min(3).max(200).describe("Kurz und verständlich, wofür – wird dem Admin angezeigt"),
      timeout_min: z.number().int().min(1).max(60).default(15),
    }, safe(async (a) => {
      requireAdmin(ctx);
      const pc = ctx.pc.find(a.computer);
      if (a.on_desktop && a.command.length > 2000) throw new Error("Für on_desktop höchstens 2000 Zeichen");
      const summary = `${pc.name}${a.on_desktop ? " (auf dem Bildschirm)" : ""}: ${a.purpose}\n\n${a.command.length > 600 ? `${a.command.slice(0, 600)}…` : a.command}`;
      const r = await ctx.actions.request("pc_command", { command: a.command, purpose: a.purpose, timeout_min: a.timeout_min, computer: pc.name, on_desktop: a.on_desktop },
        { agent: "it", summary, requestedBy: ctx.user });
      return ok(`Zur Freigabe vorgelegt (${r.id}) für ${pc.name}. Läuft erst nach Klick des Admins.`);
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
