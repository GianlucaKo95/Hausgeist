import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./log.js";

const log = logger("tv");

/** Ein gekoppelter Fernseher (Couchpotato auf Fire TV, Beamer …). Der Schlüssel liegt nur gehasht auf dem Pi. */
export interface TvDevice { id: string; name: string; model: string; tokenHash: string; pairedAt: string; lastSeen?: string }
interface Pairing { id: string; code: string; name: string; model: string; until: number; token?: string; tries: number }
interface Pending { id: string; cmd: string; args: Record<string, unknown>; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Verbindung zu Couchpotato: Die Fernseher melden sich selbst beim Hausgeist (kein offener Port am Stick nötig)
 * und holen per Long-Poll Befehle ab. Koppeln: Fernseher zeigt einen Code, der Admin gibt ihn in der App ein.
 */
export class TvHub {
  private devices: TvDevice[] = [];
  private pairings = new Map<string, Pairing>();
  private queues = new Map<string, Pending[]>();
  private waiters = new Map<string, (p: Pending | null) => void>();
  private inflight = new Map<string, Pending>();
  private online = new Map<string, number>();
  private file: string;
  private pairCalls: number[] = [];

  constructor(dataDir: string) {
    this.file = join(dataDir, "tv-devices.json");
    if (existsSync(this.file)) this.devices = JSON.parse(readFileSync(this.file, "utf8")) as TvDevice[];
  }

  private save() { writeFileSync(this.file, JSON.stringify(this.devices, null, 2)); }

  // ---------------- Koppeln ----------------

  /** Fernseher fragt einen Code an (ohne Anmeldung – daher gebremst und nur 10 Minuten gültig). */
  startPairing(name: string, model: string): { pair_id: string; code: string } {
    const now = Date.now();
    this.pairCalls = this.pairCalls.filter((t) => now - t < 60_000);
    if (this.pairCalls.length >= 10) throw Object.assign(new Error("Zu viele Kopplungsversuche – bitte kurz warten"), { status: 429 });
    this.pairCalls.push(now);
    for (const [k, p] of this.pairings) if (p.until < now) this.pairings.delete(k);
    const code = String(randomInt(100000, 1000000));
    const p: Pairing = { id: randomUUID(), code, name: name.slice(0, 40) || "Fernseher", model: model.slice(0, 60), until: now + 10 * 60_000, tries: 0 };
    this.pairings.set(p.id, p);
    return { pair_id: p.id, code };
  }

  /** Fernseher fragt nach, ob der Admin bestätigt hat. Der Schlüssel wird genau einmal ausgegeben. */
  pollPairing(id: string): { status: "waiting" | "done" | "expired"; token?: string; name?: string } {
    const p = this.pairings.get(id);
    if (!p || p.until < Date.now()) return { status: "expired" };
    if (!p.token) return { status: "waiting" };
    this.pairings.delete(id);
    return { status: "done", token: p.token, name: p.name };
  }

  /** Admin gibt den Code vom Fernseher ein. */
  confirm(code: string, name?: string): TvDevice {
    const p = [...this.pairings.values()].find((x) => x.code === code.replace(/\s/g, "") && x.until > Date.now() && !x.token);
    if (!p) throw new Error("Code unbekannt oder abgelaufen – am Fernseher neu anzeigen lassen");
    const token = randomBytes(32).toString("base64url");
    const wanted = (name?.trim() || p.name).slice(0, 40);
    const unique = this.devices.some((d) => norm(d.name) === norm(wanted)) ? `${wanted} ${this.devices.length + 1}` : wanted;
    const dev: TvDevice = { id: randomUUID(), name: unique, model: p.model, tokenHash: hash(token), pairedAt: new Date().toISOString() };
    this.devices.push(dev);
    this.save();
    p.token = token;
    p.name = unique;
    log.info(`Fernseher gekoppelt: ${unique} (${p.model})`);
    return dev;
  }

  list(): (Omit<TvDevice, "tokenHash"> & { online: boolean })[] {
    return this.devices.map(({ tokenHash: _t, ...d }) => ({ ...d, online: this.isOnline(d.id) }));
  }

  remove(id: string): void {
    this.devices = this.devices.filter((d) => d.id !== id);
    this.save();
    this.waiters.get(id)?.(null);
  }

  rename(id: string, name: string): void {
    const d = this.devices.find((x) => x.id === id);
    if (!d) throw new Error("Fernseher nicht gefunden");
    d.name = name.trim().slice(0, 40) || d.name;
    this.save();
  }

  // ---------------- Fernseher-Seite ----------------

  authenticate(bearer: string | undefined): TvDevice | null {
    if (!bearer?.startsWith("Bearer ")) return null;
    const h = hash(bearer.slice(7));
    return this.devices.find((d) => d.tokenHash === h) ?? null;
  }

  private isOnline(id: string): boolean { return Date.now() - (this.online.get(id) ?? 0) < 45_000; }

  /** Long-Poll: nächster Befehl oder null nach [waitMs]. */
  next(dev: TvDevice, waitMs: number): Promise<{ id: string; cmd: string; args: Record<string, unknown> } | null> {
    this.online.set(dev.id, Date.now());
    if (!dev.lastSeen || Date.now() - Date.parse(dev.lastSeen) > 3_600_000) { dev.lastSeen = new Date().toISOString(); this.save(); }
    const q = this.queues.get(dev.id) ?? [];
    const take = (p: Pending) => { this.inflight.set(p.id, p); return { id: p.id, cmd: p.cmd, args: p.args }; };
    if (q.length) return Promise.resolve(take(q.shift()!));
    this.waiters.get(dev.id)?.(null); // ältere Verbindung desselben Geräts beenden
    return new Promise((resolve) => {
      const t = setTimeout(() => { if (this.waiters.get(dev.id) === done) this.waiters.delete(dev.id); resolve(null); }, waitMs);
      const done = (p: Pending | null) => {
        clearTimeout(t);
        if (this.waiters.get(dev.id) === done) this.waiters.delete(dev.id);
        this.online.set(dev.id, Date.now());
        resolve(p ? take(p) : null);
      };
      this.waiters.set(dev.id, done);
    });
  }

  result(dev: TvDevice, id: string, result: unknown, error?: string): void {
    this.online.set(dev.id, Date.now());
    const p = this.inflight.get(id);
    if (!p) return;
    this.inflight.delete(id);
    clearTimeout(p.timer);
    if (error) p.reject(new Error(error)); else p.resolve(result);
  }

  // ---------------- Hausgeist-Seite ----------------

  /** Fernseher nach Name („Wohnzimmer“, „Beamer“); ohne Namen der einzige bzw. der einzige eingeschaltete. */
  find(name?: string): TvDevice {
    if (!this.devices.length) throw new Error("Kein Fernseher gekoppelt – in Couchpotato unter Einstellungen → Hausgeist koppeln.");
    if (name?.trim()) {
      const n = norm(name);
      const d = this.devices.find((x) => norm(x.name) === n) ?? this.devices.find((x) => norm(x.name).includes(n) || n.includes(norm(x.name)));
      if (!d) throw new Error(`Keinen Fernseher „${name}“ gefunden. Gekoppelt: ${this.devices.map((x) => x.name).join(", ")}`);
      return d;
    }
    if (this.devices.length === 1) return this.devices[0];
    const on = this.devices.filter((d) => this.isOnline(d.id));
    if (on.length === 1) return on[0];
    throw new Error(`Welcher Fernseher? ${this.devices.map((x) => `${x.name}${this.isOnline(x.id) ? " (an)" : ""}`).join(", ")}`);
  }

  /** Befehl an einen Fernseher schicken und auf die Antwort warten. */
  send(dev: TvDevice, cmd: string, args: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<unknown> {
    if (!this.isOnline(dev.id)) {
      return Promise.reject(new Error(`${dev.name} ist aus oder Couchpotato nicht erreichbar (Stick im Standby?).`));
    }
    return new Promise((resolve, reject) => {
      const p: Pending = {
        id: randomUUID(), cmd, args, resolve, reject,
        timer: setTimeout(() => {
          this.inflight.delete(p.id);
          const q = this.queues.get(dev.id);
          if (q) this.queues.set(dev.id, q.filter((x) => x !== p));
          reject(new Error(`${dev.name} hat nicht geantwortet.`));
        }, timeoutMs),
      };
      const w = this.waiters.get(dev.id);
      if (w) w(p);
      else this.queues.set(dev.id, [...(this.queues.get(dev.id) ?? []), p]);
    });
  }
}
