import WebSocket from "ws";
import type { Config } from "../core/config.js";
import { logger } from "../core/log.js";

const log = logger("ha");

export interface NotificationAction {
  action: string;
  title: string;
  destructive?: boolean;
}

type AppSender = (userId: string, title: string, message: string, actions: NotificationAction[], tag?: string) => Promise<boolean>;

export class HomeAssistant {
  private appSender: AppSender | null = null;

  constructor(private readonly config: Config) {}

  /** Push über die Hausgeist-App statt über die Companion-App. */
  setAppSender(sender: AppSender): void {
    this.appSender = sender;
  }

  private headers() {
    if (!this.config.supervisorToken) throw new Error("SUPERVISOR_TOKEN fehlt – läuft das Add-on mit homeassistant_api: true?");
    return { Authorization: `Bearer ${this.config.supervisorToken}`, "Content-Type": "application/json" };
  }

  /** Push an die Companion-App, optional mit Buttons (actionable notification). */
  async notify(service: string, title: string, message: string, actions: NotificationAction[] = [], tag?: string) {
    if (service.startsWith("app:")) {
      const [app, fallback] = service.split("|");
      if (this.appSender && (await this.appSender(app.slice(4), title, message, actions, tag))) return;
      if (!fallback) throw new Error("Push an die Hausgeist-App fehlgeschlagen und kein HA-Dienst hinterlegt");
      service = fallback;
    }
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

  /** Termine eines Home-Assistant-Kalenders (z. B. calendar.abfall). */
  async calendarEvents(entityId: string, startIso: string, endIso: string): Promise<{
    summary: string; location?: string | null;
    start: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
  }[]> {
    const q = `start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;
    const res = await fetch(`${this.config.haBaseUrl}/calendars/${entityId}?${q}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Kalender ${entityId}: ${res.status}`);
    return res.json() as never;
  }

  async callService(domain: string, service: string, data: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.config.haBaseUrl}/services/${domain}/${service}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`${domain}.${service} fehlgeschlagen: ${res.status} ${await res.text()}`);
  }

  /** Einzelner WebSocket-Befehl, z. B. config/area_registry/list. */
  /** Dienst mit Rückgabewert (z. B. todo.get_items). */
  async callServiceWithResponse<T>(domain: string, service: string, data: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.config.haBaseUrl}/services/${domain}/${service}?return_response`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`${domain}.${service} fehlgeschlagen: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { service_response?: T };
    return (body.service_response ?? {}) as T;
  }

  async wsCommand<T>(type: string, extra: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const ws = new WebSocket(this.config.haWsUrl);
      const timer = setTimeout(() => { ws.terminate(); reject(new Error(`${type}: Zeitüberschreitung`)); }, 15_000);
      ws.on("message", (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: this.config.supervisorToken }));
        else if (msg.type === "auth_ok") ws.send(JSON.stringify({ id: 1, type, ...extra }));
        else if (msg.type === "auth_invalid") { clearTimeout(timer); ws.close(); reject(new Error("Token abgelehnt")); }
        else if (msg.type === "result" && msg.id === 1) {
          clearTimeout(timer);
          ws.close();
          if (msg.success) resolve(msg.result as T);
          else reject(new Error(`${type}: ${msg.error?.message ?? "Fehler"}`));
        }
      });
      ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
  }

  /** Bereiche (Räume) mit ihren Entitäten. */
  async areas(): Promise<{ area: string; entities: string[] }[]> {
    const [areas, entities, devices] = await Promise.all([
      this.wsCommand<{ area_id: string; name: string }[]>("config/area_registry/list"),
      this.wsCommand<{ entity_id: string; area_id: string | null; device_id: string | null }[]>("config/entity_registry/list"),
      this.wsCommand<{ id: string; area_id: string | null }[]>("config/device_registry/list"),
    ]);
    const deviceArea = new Map(devices.map((d) => [d.id, d.area_id]));
    return areas.map((a) => ({
      area: a.name,
      entities: entities
        .filter((e) => (e.area_id ?? (e.device_id ? deviceArea.get(e.device_id) : null)) === a.area_id)
        .map((e) => e.entity_id),
    }));
  }

  /**
   * Lauscht auf Klicks in Benachrichtigungen. Liefert die Action und die
   * Home-Assistant-Benutzer-ID der Person, die geklickt hat.
   */
  onNotificationAction(handler: (action: string, haUserId: string | null) => void): void {
    let retry = 1000;
    let rejected = 0;
    const connect = () => {
      const ws = new WebSocket(this.config.haWsUrl);
      let nextId = 1;
      ws.on("message", (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === "auth_required") {
          ws.send(JSON.stringify({ type: "auth", access_token: this.config.supervisorToken }));
        } else if (msg.type === "auth_ok") {
          retry = 1000;
          rejected = 0;
          ws.send(JSON.stringify({ id: nextId++, type: "subscribe_events", event_type: "mobile_app_notification_action" }));
          log.info("Verbunden, warte auf Freigaben");
        } else if (msg.type === "auth_invalid") {
          rejected++;
          log.error(`Home Assistant hat das Token abgelehnt (${rejected}. Mal)`);
          if (rejected >= 3) {
            // Das Token vergibt der Supervisor beim Start des Add-ons. Ist es dauerhaft ungültig
            // (z. B. nach einem Supervisor-Update), hilft nur ein Neustart – den übernimmt der Watchdog.
            log.error("Token bleibt ungültig – starte neu, um ein frisches Token zu erhalten");
            setTimeout(() => process.exit(1), 500);
          }
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
