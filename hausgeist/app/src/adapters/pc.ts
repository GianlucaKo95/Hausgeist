import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import ssh2 from "ssh2";

const { Client, utils } = ssh2;
import { allPcs, type Config, type PcConfig } from "../core/config.js";

/** Ist ein TCP-Port erreichbar? (z. B. 22 = SSH, 445/3389 = Windows) */
export function portOpen(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host, port });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** Sieht ein Gerätename nach Computer aus? (FRITZ!Box-Geräteliste) */
export function looksLikeComputer(name: string): boolean {
  return /(desktop|laptop|notebook|book|pc\b|-pc|surface|thinkpad|elitebook|probook|latitude|inspiron|xps|zenbook|vivobook|ideapad|yoga|legion|omen|pavilion|aspire|predator|rog|tuf|macbook|imac|mac-?mini|mac-?studio|win(dows)?-|workstation|rechner|computer)/i.test(name);
}

export interface CommandResult { code: number | null; stdout: string; stderr: string }

/** PowerShell-Befehl als -EncodedCommand (UTF-16LE, Base64) – keine Probleme mit Anführungszeichen. */
export function encodePowerShell(script: string): string {
  const full = `$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Continue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8\n${script}`;
  return Buffer.from(full, "utf16le").toString("base64");
}

function clip(s: string, max = 6000): string {
  return s.length > max ? `${s.slice(0, max / 2)}\n… (${s.length - max} Zeichen gekürzt) …\n${s.slice(-max / 2)}` : s;
}

/**
 * Windows-PC per SSH (OpenSSH-Server von Windows). Der Hausgeist hat einen eigenen
 * Schlüssel; der Fingerabdruck des PCs wird beim ersten Kontakt gemerkt und danach geprüft.
 * Befehle laufen nur über freigegebene Aktionen (siehe ActionService).
 */
export class WindowsPc {
  private readonly dir: string;

  constructor(private readonly config: Config) {
    this.dir = join(config.dataDir, "ssh");
  }

  get enabled(): boolean {
    return allPcs(this.config).length > 0;
  }

  list(): PcConfig[] {
    return allPcs(this.config);
  }

  /** Computer nach Name (ohne Groß-/Kleinschreibung); ohne Angabe der einzige bzw. erste. */
  find(name?: string): PcConfig {
    const pcs = this.list();
    if (!pcs.length) throw new Error("Noch kein Computer eingerichtet (App → Verwaltung → Netzwerk & PC).");
    if (!name) {
      if (pcs.length > 1) throw new Error(`Welcher Computer? Eingerichtet: ${pcs.map((p) => p.name).join(", ")}`);
      return pcs[0];
    }
    const n = name.trim().toLowerCase();
    const hit = pcs.find((p) => p.name.toLowerCase() === n) ?? pcs.find((p) => p.name.toLowerCase().includes(n) || n.includes(p.name.toLowerCase()));
    if (!hit) throw new Error(`Einen Computer „${name}“ kenne ich nicht. Eingerichtet: ${pcs.map((p) => p.name).join(", ")}`);
    return hit;
  }

  /** Eigener SSH-Schlüssel (wird beim ersten Aufruf erzeugt). */
  keyPair(): { privateKey: string; publicKey: string } {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const priv = join(this.dir, "id_ed25519");
    const pub = `${priv}.pub`;
    if (!existsSync(priv)) {
      const k = utils.generateKeyPairSync("ed25519", { comment: "hausgeist" });
      writeFileSync(priv, k.private, { mode: 0o600 });
      writeFileSync(pub, k.public, { mode: 0o644 });
    }
    return { privateKey: readFileSync(priv, "utf8"), publicKey: readFileSync(pub, "utf8").trim() };
  }

  private knownHostsPath(): string {
    return join(this.dir, "known_host.json");
  }

  /** Gemerkten Fingerabdruck vergessen (z. B. nach Neuinstallation von Windows). */
  forgetHost(host?: string): void {
    try {
      if (!host) { writeFileSync(this.knownHostsPath(), "{}"); return; }
      const known = JSON.parse(readFileSync(this.knownHostsPath(), "utf8"));
      delete known[host];
      writeFileSync(this.knownHostsPath(), JSON.stringify(known), { mode: 0o600 });
    } catch { /* noch nichts gemerkt */ }
  }

  /** Ist der PC an und SSH erreichbar? (ohne Anmeldung) */
  online(pc: PcConfig = this.find(), timeoutMs = 3000): Promise<boolean> {
    return portOpen(pc.host, pc.port || 22, timeoutMs);
  }

  async run(script: string, timeoutMs = 10 * 60_000, pc: PcConfig = this.find()): Promise<CommandResult> {
    const { privateKey } = this.keyPair();
    const host = pc.host;
    let known: Record<string, string> = {};
    try { known = JSON.parse(readFileSync(this.knownHostsPath(), "utf8")); } catch { /* erster Kontakt */ }
    let hostMismatch = false;

    return new Promise((resolve, reject) => {
      const conn = new Client();
      const timer = setTimeout(() => { conn.end(); reject(new Error("Zeitüberschreitung – der Befehl lief zu lange")); }, timeoutMs);
      conn.on("ready", () => {
        conn.exec(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(script)}`, (err, stream) => {
          if (err) { clearTimeout(timer); conn.end(); reject(err); return; }
          let stdout = "";
          let stderr = "";
          stream.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
          stream.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
          stream.on("close", (code: number | null) => {
            clearTimeout(timer);
            conn.end();
            // PowerShell meldet Fortschritt als CLIXML auf stderr – das ist kein Fehler.
            const cleanErr = stderr.includes("#< CLIXML") ? stderr.replace(/#< CLIXML[\s\S]*$/, "").trim() : stderr.trim();
            resolve({ code, stdout: clip(stdout.trim()), stderr: clip(cleanErr, 2000) });
          });
        });
      });
      conn.on("error", (e) => {
        clearTimeout(timer);
        reject(hostMismatch
          ? new Error("Der PC meldet sich mit einem anderen Schlüssel als bisher. Aus Sicherheitsgründen abgebrochen – in der App „PC neu kennenlernen“ wählen, falls Windows neu installiert wurde.")
          : new Error(/authentication/i.test(e.message) ? "Anmeldung am PC abgelehnt – ist der Hausgeist-Schlüssel auf dem PC hinterlegt?" : `PC nicht erreichbar: ${e.message}`));
      });
      conn.connect({
        host,
        port: pc.port || 22,
        username: pc.user,
        privateKey,
        readyTimeout: 15_000,
        hostVerifier: (key: Buffer) => {
          const fp = createHash("sha256").update(key).digest("base64");
          if (!known[host]) {
            known[host] = fp;
            writeFileSync(this.knownHostsPath(), JSON.stringify(known), { mode: 0o600 });
            return true;
          }
          hostMismatch = known[host] !== fp;
          return !hostMismatch;
        },
      });
    });
  }
}

export interface DiscoveredComputer {
  name: string; ip: string; mac: string; active: boolean; connection: string;
  windows: boolean | null; ssh: boolean; configuredAs: string | null;
}

/** Computer aus der FRITZ!Box-Geräteliste, mit Prüfung ob SSH schon bereit ist. */
export async function discoverComputers(
  hosts: { name: string; ip: string; mac: string; active: boolean; connection: string }[],
  known: PcConfig[],
): Promise<DiscoveredComputer[]> {
  // Nicht nur nach Gerätenamen gehen: jedes eingeschaltete Gerät wird auf SSH/Windows-Ports geprüft
  const found = await Promise.all(hosts.filter((h) => h.ip).map(async (h) => {
    const named = looksLikeComputer(h.name) || known.some((k) => k.mac && k.mac === h.mac.toUpperCase());
    if (!h.active && !named) return null;
    const ssh = h.active ? await portOpen(h.ip, 22, 1200) : false;
    const windows = h.active ? (await portOpen(h.ip, 445, 800)) || (await portOpen(h.ip, 3389, 800)) : null;
    if (!named && !ssh && !windows) return null;
    const configured = known.find((k) => k.host === h.ip || k.host.toLowerCase() === h.name.toLowerCase() || (k.mac && k.mac === h.mac.toUpperCase()));
    return { name: h.name, ip: h.ip, mac: h.mac.toUpperCase(), active: h.active, connection: h.connection, windows, ssh, configuredAs: configured?.name ?? null };
  }));
  return found.filter((c): c is DiscoveredComputer => c !== null);
}
