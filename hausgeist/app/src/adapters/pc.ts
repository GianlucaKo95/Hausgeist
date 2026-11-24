import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import ssh2 from "ssh2";

const { Client, utils } = ssh2;
import type { Config } from "../core/config.js";

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
    return Boolean(this.config.pc.host && this.config.pc.user);
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
  forgetHost(): void {
    try { writeFileSync(this.knownHostsPath(), "{}"); } catch { /* egal */ }
  }

  /** Ist der PC an und SSH erreichbar? (ohne Anmeldung) */
  online(timeoutMs = 3000): Promise<boolean> {
    if (!this.enabled) return Promise.resolve(false);
    return new Promise((resolve) => {
      const s = createConnection({ host: this.config.pc.host, port: this.config.pc.port || 22 });
      const done = (v: boolean) => { s.destroy(); resolve(v); };
      s.setTimeout(timeoutMs, () => done(false));
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
    });
  }

  async run(script: string, timeoutMs = 10 * 60_000): Promise<CommandResult> {
    if (!this.enabled) throw new Error("Der PC ist nicht eingerichtet – in der App unter Verwaltung → Netzwerk & PC eintragen.");
    const { privateKey } = this.keyPair();
    const host = this.config.pc.host;
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
        port: this.config.pc.port || 22,
        username: this.config.pc.user,
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
