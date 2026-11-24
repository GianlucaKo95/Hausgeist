import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HomeAssistant } from "../adapters/homeassistant.js";
import type { AppUser } from "./checks.js";

type HaState = { entity_id: string; state: string; attributes: Record<string, unknown>; last_changed?: string };
export interface Position { lat: number; lon: number; zone: string; accuracy?: number; updated?: string }

/** Zonennamen vergleichbar machen („Zuhause“ = home). */
export function normZone(z: string): string {
  const s = z.trim().toLowerCase();
  return ["home", "zuhause", "daheim", "zu hause"].includes(s) ? "home" : s === "not_home" ? "unterwegs" : s;
}

/** Hat jemand eine Zone gerade betreten bzw. verlassen? */
export function zoneEdge(prev: string | null, now: string, zone: string, event: "enter" | "leave"): boolean {
  if (prev === null) return false; // erster Blick: nur merken
  const z = normZone(zone);
  const p = normZone(prev);
  const n = normZone(now);
  return event === "enter" ? p !== z && n === z : p === z && n !== z;
}

/** Person-Entität in Home Assistant zur Hausgeist-Person (über die HA-Benutzer-ID). */
export function personFor(user: AppUser, states: HaState[]): HaState | undefined {
  if (!user.ha_user_id) return undefined;
  return states.find((s) => s.entity_id.startsWith("person.") && s.attributes.user_id === user.ha_user_id);
}

export function positionOf(person: HaState | undefined, states: HaState[]): Position | null {
  if (!person) return null;
  const lat = Number(person.attributes.latitude);
  const lon = Number(person.attributes.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // Zonenname: „home“ oder der Anzeigename der Zone
  return { lat, lon, zone: person.state, accuracy: Number(person.attributes.gps_accuracy) || undefined };
}

export function zones(states: HaState[]): { name: string; entity_id: string }[] {
  return states.filter((s) => s.entity_id.startsWith("zone.")).map((s) => ({
    name: s.entity_id === "zone.home" ? "home" : String(s.attributes.friendly_name ?? s.entity_id.slice(5)),
    entity_id: s.entity_id,
  }));
}

/**
 * Ortsauflösung (Nominatim) und Fahrzeiten (OSRM) über OpenStreetMap – ohne API-Schlüssel.
 * Adressen werden zwischengespeichert, damit die Dienste nur selten gefragt werden.
 */
export class Travel {
  private cache: Record<string, { lat: number; lon: number } | null>;
  private readonly cachePath: string;

  constructor(dataDir: string) {
    this.cachePath = join(dataDir, "geocode.json");
    this.cache = existsSync(this.cachePath) ? JSON.parse(readFileSync(this.cachePath, "utf8")) : {};
  }

  async geocode(address: string): Promise<{ lat: number; lon: number } | null> {
    const key = address.trim().toLowerCase();
    if (key in this.cache) return this.cache[key];
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=de,at,ch,nl,be,it,fr&q=${encodeURIComponent(address.replace(/\n/g, ", "))}`;
    const res = await fetch(url, { headers: { "User-Agent": "Hausgeist/1.0 (Home-Assistant-Add-on, privat)" }, signal: AbortSignal.timeout(10000) });
    const list = res.ok ? (await res.json()) as { lat: string; lon: string }[] : [];
    const hit = list[0] ? { lat: Number(list[0].lat), lon: Number(list[0].lon) } : null;
    this.cache[key] = hit;
    writeFileSync(this.cachePath, JSON.stringify(this.cache));
    return hit;
  }

  /** Fahrzeit in Minuten (ohne Verkehr). */
  async minutes(from: { lat: number; lon: number }, to: { lat: number; lon: number }, mode: "car" | "bike" | "foot"): Promise<number | null> {
    const profile = { car: "routed-car/route/v1/driving", bike: "routed-bike/route/v1/bike", foot: "routed-foot/route/v1/foot" }[mode];
    const url = `https://routing.openstreetmap.de/${profile}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
    const res = await fetch(url, { headers: { "User-Agent": "Hausgeist/1.0" }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { routes?: { duration: number }[] };
    const s = body.routes?.[0]?.duration;
    return s === undefined ? null : Math.round(s / 60);
  }
}

/** Wann muss man los? Fahrzeit plus Puffer, bei Auto 15 % Verkehrszuschlag. */
export function leaveAt(start: Date, travelMin: number, bufferMin: number, mode: "car" | "bike" | "foot"): Date {
  const travel = mode === "car" ? Math.ceil(travelMin * 1.15) : travelMin;
  return new Date(start.getTime() - (travel + bufferMin) * 60_000);
}

export interface Place { name: string; lat: number; lon: number; radius: number }

/** Zonen mit Koordinaten (für die App: Geofences). */
export function places(states: HaState[]): Place[] {
  return states.filter((s) => s.entity_id.startsWith("zone.") && Number.isFinite(Number(s.attributes.latitude)))
    .map((s) => ({
      name: s.entity_id === "zone.home" ? "home" : String(s.attributes.friendly_name ?? s.entity_id.slice(5)),
      lat: Number(s.attributes.latitude), lon: Number(s.attributes.longitude), radius: Number(s.attributes.radius) || 100,
    }));
}

export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** In welcher Zone liegt ein Punkt? Sonst „not_home“ (unterwegs). */
export function zoneAt(pos: { lat: number; lon: number }, list: Place[]): string {
  const inside = list.map((p) => ({ p, d: distanceM(pos, p) })).filter((x) => x.d <= x.p.radius).sort((a, b) => a.d - b.d);
  return inside[0]?.p.name ?? "not_home";
}

/**
 * Standort aus der Hausgeist-App (funktioniert auch ohne VPN). Liegt nur auf dem Pi,
 * nicht in Supabase, und gilt nur für die eigene Person.
 */
export class Positions {
  private readonly path: string;
  private data: Record<string, { lat?: number; lon?: number; accuracy?: number; zone: string; at: number }>;

  constructor(dataDir: string) {
    this.path = join(dataDir, "positions.json");
    try { this.data = JSON.parse(readFileSync(this.path, "utf8")); } catch { this.data = {}; }
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify(this.data), { mode: 0o600 });
  }

  update(userId: string, pos: { lat: number; lon: number; accuracy?: number }, zone: string): void {
    this.data[userId] = { ...pos, zone, at: Date.now() };
    this.save();
  }

  /** Geofence-Ereignis der App: Zone betreten/verlassen. */
  zoneEvent(userId: string, zone: string, event: "enter" | "leave"): void {
    const cur = this.data[userId];
    if (event === "enter") this.data[userId] = { ...cur, zone, at: Date.now() };
    else if (!cur || normZone(cur.zone) === normZone(zone)) this.data[userId] = { ...cur, zone: "not_home", at: Date.now() };
    this.save();
  }

  get(userId: string, maxAgeMs = 12 * 3600_000) {
    const p = this.data[userId];
    return p && Date.now() - p.at <= maxAgeMs ? p : undefined;
  }

  clear(userId: string): void {
    delete this.data[userId];
    this.save();
  }
}

/** Aktuelle Zone/Position: zuerst aus der Hausgeist-App, sonst aus Home Assistant. */
export function whereIs(user: AppUser, positions: Positions, states: HaState[]): { zone: string; pos: { lat: number; lon: number } | null; source: "app" | "ha" } | null {
  const app = positions.get(user.id);
  if (app) return { zone: app.zone, pos: app.lat !== undefined && app.lon !== undefined ? { lat: app.lat, lon: app.lon } : null, source: "app" };
  const person = personFor(user, states);
  if (!person) return null;
  return { zone: person.state, pos: positionOf(person, states), source: "ha" };
}
