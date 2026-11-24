import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db.js";
import { logger } from "./log.js";
import type { AppUser } from "./checks.js";

const log = logger("planner");

/** Ein gekoppeltes Gerät mit dem Familienplaner (Wandtablet, Handy …). Schlüssel nur gehasht auf dem Pi. */
export interface PlannerDevice { id: string; name: string; tokenHash: string; pairedAt: string; lastSeen?: string }
interface Pairing { id: string; code: string; name: string; until: number; token?: string }

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
export const PLANNER_TOKEN_PREFIX = "hp_";

/**
 * Familienplaner-Anbindung: Der Planer meldet sich mit einem Geräteschlüssel als gemeinsamer
 * Familienaccount (Rolle „family“) an – ohne Freigaben, Finanzen, Mail oder IT.
 * Koppeln wie beim Fernseher: Planer zeigt einen Code, der Admin bestätigt ihn in der App.
 */
export class PlannerLink {
  private devices: PlannerDevice[] = [];
  private pairings = new Map<string, Pairing>();
  private pairCalls: number[] = [];
  private file: string;
  private familyUser: AppUser | null = null;

  constructor(dataDir: string) {
    this.file = join(dataDir, "planner-devices.json");
    if (existsSync(this.file)) this.devices = JSON.parse(readFileSync(this.file, "utf8")) as PlannerDevice[];
  }

  private save() { writeFileSync(this.file, JSON.stringify(this.devices, null, 2)); }

  startPairing(name: string): { pair_id: string; code: string } {
    const now = Date.now();
    this.pairCalls = this.pairCalls.filter((t) => now - t < 60_000);
    if (this.pairCalls.length >= 10) throw Object.assign(new Error("Zu viele Kopplungsversuche – bitte kurz warten"), { status: 429 });
    this.pairCalls.push(now);
    for (const [k, p] of this.pairings) if (p.until < now) this.pairings.delete(k);
    const p: Pairing = { id: randomUUID(), code: String(randomInt(100000, 1000000)), name: name.trim().slice(0, 40) || "Familienplaner", until: now + 10 * 60_000 };
    this.pairings.set(p.id, p);
    return { pair_id: p.id, code: p.code };
  }

  pollPairing(id: string): { status: "waiting" | "done" | "expired"; token?: string; name?: string } {
    const p = this.pairings.get(id);
    if (!p || p.until < Date.now()) return { status: "expired" };
    if (!p.token) return { status: "waiting" };
    this.pairings.delete(id);
    return { status: "done", token: p.token, name: p.name };
  }

  confirm(code: string, name?: string): Omit<PlannerDevice, "tokenHash"> {
    const p = [...this.pairings.values()].find((x) => x.code === code.replace(/\s/g, "") && x.until > Date.now() && !x.token);
    if (!p) throw new Error("Code unbekannt oder abgelaufen – im Familienplaner neu anzeigen lassen");
    const token = PLANNER_TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const dev: PlannerDevice = { id: randomUUID(), name: (name?.trim() || p.name).slice(0, 40), tokenHash: hash(token), pairedAt: new Date().toISOString() };
    this.devices.push(dev);
    this.save();
    p.token = token;
    p.name = dev.name;
    log.info(`Familienplaner gekoppelt: ${dev.name}`);
    const { tokenHash: _t, ...rest } = dev;
    return rest;
  }

  list(): Omit<PlannerDevice, "tokenHash">[] {
    return this.devices.map(({ tokenHash: _t, ...d }) => d);
  }

  remove(id: string): void {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) throw new Error("Gerät nicht gefunden");
    this.save();
  }

  rename(id: string, name: string): void {
    const d = this.devices.find((x) => x.id === id);
    if (!d) throw new Error("Gerät nicht gefunden");
    d.name = name.trim().slice(0, 40) || d.name;
    this.save();
  }

  /** Bearer-Schlüssel eines Planer-Geräts → Familienaccount (oder null). */
  async authenticate(token: string): Promise<AppUser | null> {
    if (!token.startsWith(PLANNER_TOKEN_PREFIX)) return null;
    const h = hash(token);
    const dev = this.devices.find((d) => d.tokenHash === h);
    if (!dev) return null;
    const now = new Date().toISOString();
    if (!dev.lastSeen || Date.parse(now) - Date.parse(dev.lastSeen) > 10 * 60_000) { dev.lastSeen = now; this.save(); }
    return this.family();
  }

  /** Der gemeinsame Familienaccount – wird beim ersten Bedarf angelegt. */
  async family(): Promise<AppUser> {
    if (this.familyUser) return this.familyUser;
    const { data: found } = await db().from("users").select("id, name, role, approval_limit_cents, ha_user_id, notify_service").eq("role", "family").limit(1).maybeSingle();
    if (found) return (this.familyUser = found as AppUser);
    const { data, error } = await db().from("users")
      .insert({ name: "Familie", role: "family", approval_limit_cents: 0 })
      .select("id, name, role, approval_limit_cents, ha_user_id, notify_service").single();
    if (error) throw error;
    log.info("Familienaccount angelegt");
    return (this.familyUser = data as AppUser);
  }
}
