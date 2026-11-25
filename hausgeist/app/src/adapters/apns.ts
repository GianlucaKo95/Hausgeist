import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, type ClientHttp2Session } from "node:http2";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import type { Config } from "../core/config.js";
import { db } from "../core/db.js";
import { logger } from "../core/log.js";

const log = logger("push");

export interface PushAction {
  action: string;
  title: string;
  destructive?: boolean;
}

/** Den .p8-Schlüssel aus der Add-on-Konfiguration lesen – mit oder ohne Zeilenumbrüche, auch als \n. */
export function normalizeP8(raw: string): string {
  const body = raw
    .replace(/\\n/g, "\n")
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Push-Nachrichten direkt an die Hausgeist-App (Apple Push Notification service),
 * mit Token-Authentifizierung (.p8-Schlüssel aus dem Apple-Developer-Konto).
 */
export class ApnsClient {
  private key: KeyObject | null = null;
  private jwt: { token: string; at: number } | null = null;
  private sessions = new Map<string, ClientHttp2Session>();

  private tokenCache = new Map<string, { token: string; environment: string }[]>();
  private cacheFile: string;

  constructor(private readonly config: Config) {
    this.cacheFile = join(config.dataDir ?? "/data", "push-devices-cache.json");
    try { if (existsSync(this.cacheFile)) this.tokenCache = new Map(Object.entries(JSON.parse(readFileSync(this.cacheFile, "utf8")))); } catch { /* egal */ }
    if (this.enabled) this.key = createPrivateKey(normalizeP8(config.apns_key));
  }

  get enabled(): boolean {
    return Boolean(this.config.apns_key_id && this.config.apns_team_id && this.config.apns_key);
  }

  private token(): string {
    // Apple erlaubt einen neuen Token höchstens alle 20 Minuten und nimmt ihn bis 60 Minuten an.
    if (this.jwt && Date.now() - this.jwt.at < 45 * 60_000) return this.jwt.token;
    const header = b64url(JSON.stringify({ alg: "ES256", kid: this.config.apns_key_id }));
    const claims = b64url(JSON.stringify({ iss: this.config.apns_team_id, iat: Math.floor(Date.now() / 1000) }));
    const sig = sign("sha256", Buffer.from(`${header}.${claims}`), { key: this.key!, dsaEncoding: "ieee-p1363" });
    this.jwt = { token: `${header}.${claims}.${b64url(sig)}`, at: Date.now() };
    return this.jwt.token;
  }

  private session(env: string): ClientHttp2Session {
    const host = env === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
    const existing = this.sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const s = connect(host);
    s.on("error", (e) => log.warn("APNs-Verbindung", e));
    s.on("close", () => this.sessions.delete(host));
    this.sessions.set(host, s);
    return s;
  }

  private send(deviceToken: string, env: string, payload: unknown, collapseId?: string): Promise<{ status: number; reason?: string }> {
    return new Promise((resolve) => {
      const req = this.session(env).request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${this.token()}`,
        "apns-topic": this.config.apns_bundle_id,
        "apns-push-type": "alert",
        "apns-priority": "10",
        ...(collapseId ? { "apns-collapse-id": collapseId.slice(0, 64) } : {}),
      });
      let status = 0;
      let body = "";
      req.on("response", (h) => { status = Number(h[":status"]); });
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        let reason: string | undefined;
        try { reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined; } catch { /* leer */ }
        resolve({ status, reason });
      });
      req.on("error", (e) => resolve({ status: 0, reason: e.message }));
      req.setTimeout(15_000, () => { req.close(); resolve({ status: 0, reason: "timeout" }); });
      req.end(JSON.stringify(payload));
    });
  }

  /**
   * An alle Geräte einer Person. Bei zwei Aktionen (Freigeben/Ablehnen) wird die
   * Kategorie HG_DECISION gesetzt; die App zeigt dann die Knöpfe direkt in der Mitteilung.
   * Gibt true zurück, wenn mindestens ein Gerät erreicht wurde.
   */
  async notifyUser(userId: string, title: string, message: string, actions: PushAction[] = [], tag?: string): Promise<boolean> {
    if (!this.enabled) return false;
    let devices: { token: string; environment: string }[] | null = null;
    try {
      const { data, error } = await db().from("push_devices").select("token, environment").eq("user_id", userId).abortSignal(AbortSignal.timeout(8_000));
      if (error) throw error;
      devices = data as { token: string; environment: string }[];
      this.tokenCache.set(userId, devices);
      try { writeFileSync(this.cacheFile, JSON.stringify(Object.fromEntries(this.tokenCache)), { mode: 0o600 }); } catch { /* egal */ }
    } catch {
      // Datenbank hängt: mit den zuletzt bekannten Geräten zustellen
      devices = this.tokenCache.get(userId) ?? null;
    }
    if (!devices?.length) return false;
    const payload = {
      aps: {
        alert: { title, body: message },
        sound: "default",
        "interruption-level": actions.length ? "time-sensitive" : "active",
        ...(actions.length === 2 ? { category: "HG_DECISION" } : {}),
        ...(tag ? { "thread-id": tag } : {}),
      },
      hg_actions: actions.map((a) => a.action),
    };
    let delivered = false;
    for (const d of devices) {
      const r = await this.send(d.token, d.environment, payload, tag);
      if (r.status === 200) delivered = true;
      else if (r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered") {
        await db().from("push_devices").delete().eq("token", d.token);
        log.info("Abgemeldetes Gerät entfernt");
      } else {
        log.warn(`Push fehlgeschlagen (${r.status} ${r.reason ?? ""})`);
      }
    }
    return delivered;
  }
}
