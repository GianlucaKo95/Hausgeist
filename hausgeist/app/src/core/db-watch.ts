import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, listUsers } from "./db.js";
import { logger } from "./log.js";
import type { Config } from "./config.js";
import type { AppUser } from "./checks.js";

const log = logger("db-wache");

/**
 * Wache über die Supabase-Schnittstelle. Hintergrund: Nach Wartungsarbeiten bei Supabase
 * (Verbindungen werden getrennt) erholt sich der Verbindungspool der REST-Schnittstelle
 * manchmal nicht mehr – jede Anfrage endet dann in einer Zeitüberschreitung, bis das Projekt
 * neu startet. Die Wache merkt das, schickt eine Push-Nachricht (an zwischengespeicherte
 * Empfänger, denn die Datenbank ist ja weg) und startet das Projekt – wenn ein
 * Zugangsschlüssel hinterlegt ist – selbst neu.
 */
export class DbWatch {
  private failingSince: number | null = null;
  private warned = false;
  private lastRestart = 0;
  private admins: AppUser[] = [];
  private busy = false;

  private file: string;

  constructor(private config: Config, private notify: (service: string, title: string, msg: string) => Promise<void>) {
    this.file = join(config.dataDir, "db-watch.json");
    try { if (existsSync(this.file)) this.admins = JSON.parse(readFileSync(this.file, "utf8")) as AppUser[]; } catch { /* egal */ }
  }

  /** Läuft gerade eine Störung? */
  get down(): boolean { return this.failingSince !== null; }

  /** Jede Minute aus dem Scheduler (auch wenn sonst alles hängt). */
  async check(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const ok = await this.probe();
      if (ok) {
        if (this.failingSince && this.warned) await this.tell("Datenbank wieder erreichbar", `Nach ${this.minutes()} Minuten läuft wieder alles.`);
        if (this.failingSince) log.info(`Datenbank wieder erreichbar nach ${this.minutes()} Min.`);
        this.failingSince = null;
        this.warned = false;
        // Empfänger für den Notfall merken
        try {
          this.admins = (await listUsers()).filter((u) => u.role === "admin" && u.notify_service);
          writeFileSync(this.file, JSON.stringify(this.admins), { mode: 0o600 });
        } catch { /* nächstes Mal */ }
        return;
      }
      this.failingSince ??= Date.now();
      const mins = this.minutes();
      log.warn(`Datenbank antwortet nicht (seit ${mins} Min.)`);
      if (mins >= 3 && !this.warned) {
        this.warned = true;
        await this.tell("Datenbank hängt", this.config.supabase_access_token
          ? `Supabase antwortet seit ${mins} Minuten nicht. Ich starte das Projekt in 2 Minuten automatisch neu, falls es sich nicht erholt.`
          : `Supabase antwortet seit ${mins} Minuten nicht – der Hausgeist kann nichts speichern oder anmelden. Bitte im Supabase-Dashboard „Restart project“ ausführen.`);
      }
      if (mins >= 5 && this.config.supabase_access_token && Date.now() - this.lastRestart > 60 * 60_000) {
        this.lastRestart = Date.now();
        const r = await this.restart();
        await this.tell("Datenbank wird neu gestartet", r);
      }
    } finally { this.busy = false; }
  }

  private minutes(): number { return this.failingSince ? Math.round((Date.now() - this.failingSince) / 60_000) : 0; }

  private async probe(): Promise<boolean> {
    try {
      const { error } = await db().from("users").select("id").limit(1).abortSignal(AbortSignal.timeout(15_000));
      return !error;
    } catch { return false; }
  }

  private async tell(title: string, msg: string): Promise<void> {
    for (const u of this.admins) {
      try { await this.notify(u.notify_service!, title, msg); } catch (e) { log.error("Warnung nicht zugestellt", e); }
    }
  }

  private async restart(): Promise<string> {
    const ref = new URL(this.config.supabase_url).hostname.split(".")[0];
    try {
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/restart`, {
        method: "POST", headers: { Authorization: `Bearer ${this.config.supabase_access_token}` }, signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) { log.info("Supabase-Projekt automatisch neu gestartet"); return "Neustart ausgelöst – in 2–3 Minuten sollte alles wieder laufen."; }
      return `Automatischer Neustart abgelehnt (${res.status}) – bitte im Supabase-Dashboard neu starten.`;
    } catch (e) {
      return `Automatischer Neustart fehlgeschlagen (${(e as Error).message}) – bitte im Supabase-Dashboard neu starten.`;
    }
  }
}
