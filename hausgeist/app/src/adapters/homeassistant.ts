import WebSocket from "ws";
import type { Config } from "../core/config.js";
import { logger } from "../core/log.js";

const log = logger("ha");

export interface NotificationAction {
  action: string;
  title: string;
  destructive?: boolean;
}

export class HomeAssistant {
  constructor(private readonly config: Config) {}

  private headers() {
    if (!this.config.supervisorToken) throw new Error("SUPERVISOR_TOKEN fehlt – läuft das Add-on mit homeassistant_api: true?");
    return { Authorization: `Bearer ${this.config.supervisorToken}`, "Content-Type": "application/json" };
  }

  /** Push an die Companion-App, optional mit Buttons (actionable notification). */
  async notify(service: string, title: string, message: string, actions: NotificationAction[] = [], tag?: string) {
    const res = await fetch(`${this.config.haBaseUrl}/services/notify/${service}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        title,
        message,
        data: { actions, ...(tag ? { tag } : {}), push: { "interruption-level": "time-sensitive" } },
      }),
    });
    if (!res.ok) throw new Error(`notify.${service} fehlgeschlagen: ${res.status} ${await res.text()}`);
  }

  async states(): Promise<{ entity_id: string; state: string; attributes: Record<string, unknown>; last_changed: string }[]> {
    const res = await fetch(`${this.config.haBaseUrl}/states`, { headers: this.headers() });
    if (!res.ok) throw new Error(`states: ${res.status}`);
    return res.json() as Promise<{ entity_id: string; state: string; attributes: Record<string, unknown>; last_changed: string }[]>;
  }

  async state(entityId: string): Promise<{ entity_id: string; state: string; attributes: Record<string, unknown> } | null> {
    const res = await fetch(`${this.config.haBaseUrl}/states/${entityId}`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`state ${entityId}: ${res.status}`);
    return res.json() as Promise<{ entity_id: string; state: string; attributes: Record<string, unknown> }>;
  }

  /** Verlauf eines Sensors (für Energieauswertungen). */
  async history(entityId: string, hours: number): Promise<{ state: string; last_changed: string }[]> {
    const start = new Date(Date.now() - hours * 3_600_000).toISOString();
    const res = await fetch(
      `${this.config.haBaseUrl}/history/period/${start}?filter_entity_id=${entityId}&minimal_response&no_attributes`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`history ${entityId}: ${res.status}`);
    const data = (await res.json()) as { state: string; last_changed: string }[][];
    return data[0] ?? [];
  }

  async callService(domain: string, service: string, data: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.config.haBaseUrl}/services/${domain}/${service}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`${domain}.${service} fehlgeschlagen: ${res.status} ${await res.text()}`);
  }

  /**
   * Lauscht auf Klicks in Benachrichtigungen. Liefert die Action und die
   * Home-Assistant-Benutzer-ID der Person, die geklickt hat.
   */
  onNotificationAction(handler: (action: string, haUserId: string | null) => void): void {
    let retry = 1000;
    const connect = () => {
      const ws = new WebSocket(this.config.haWsUrl);
      let nextId = 1;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "auth_required") {
          ws.send(JSON.stringify({ type: "auth", access_token: this.config.supervisorToken }));
        } else if (msg.type === "auth_ok") {
          retry = 1000;
          ws.send(JSON.stringify({ id: nextId++, type: "subscribe_events", event_type: "mobile_app_notification_action" }));
          log.info("Verbunden, warte auf Freigaben");
        } else if (msg.type === "auth_invalid") {
          log.error("Home Assistant hat das Token abgelehnt");
        } else if (msg.type === "event") {
          const ev = msg.event;
          handler(String(ev?.data?.action ?? ""), ev?.context?.user_id ?? null);
        }
      });
      ws.on("close", () => {
        log.warn(`Verbindung getrennt, neuer Versuch in ${retry / 1000}s`);
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 60_000);
      });
      ws.on("error", (e) => log.warn("WebSocket-Fehler", e));
    };
    connect();
  }
}
