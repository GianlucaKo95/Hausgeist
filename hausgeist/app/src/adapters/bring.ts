import type { Config } from "../core/config.js";

const BASE = "https://api.getbring.com/rest";
// Öffentlicher Schlüssel der Bring!-Web-App (wie auch von Home Assistant genutzt)
const API_KEY = "cof4Nc6D8saplXjE3h3HXqHH8m7VU2i1Gs0g85Sp";

export interface BringListInfo { listUuid: string; name: string }
export interface BringEntry { uuid: string; name: string; spec: string; done: boolean }

type Session = { uuid: string; token: string; refresh: string; expires: number; publicUuid?: string };

/**
 * Bring! direkt (statt über Home Assistant, das nur alle 90 s abfragt).
 * Änderungen sind sofort in der Bring!-App sichtbar; andere Listen-Mitglieder bekommen eine Bring!-Mitteilung.
 */
export class BringClient {
  private session: Session | null = null;

  constructor(private readonly config: Config) {}

  get enabled(): boolean {
    return Boolean(this.config.bring?.email && this.config.bring?.password);
  }

  reset(): void {
    this.session = null;
  }

  private headers(s?: Session): Record<string, string> {
    return {
      "X-BRING-API-KEY": API_KEY,
      "X-BRING-CLIENT": "webApp",
      "X-BRING-APPLICATION": "bring",
      "X-BRING-COUNTRY": "DE",
      ...(s ? { Authorization: `Bearer ${s.token}`, "X-BRING-USER-UUID": s.uuid } : {}),
    };
  }

  /** Anmelden (auch für den Test aus der App mit anderen Zugangsdaten). */
  async login(email = this.config.bring.email, password = this.config.bring.password): Promise<Session> {
    const res = await fetch(`${BASE}/v2/bringauth`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email, password }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 404) throw new Error("Bring! lehnt E-Mail oder Passwort ab.");
    if (!res.ok) throw new Error(`Bring!-Anmeldung fehlgeschlagen (${res.status})`);
    const b = (await res.json()) as { uuid: string; access_token: string; refresh_token: string; expires_in: number; publicUuid?: string };
    return { uuid: b.uuid, token: b.access_token, refresh: b.refresh_token, expires: Date.now() + (b.expires_in - 120) * 1000, publicUuid: b.publicUuid };
  }

  private async auth(): Promise<Session> {
    if (!this.enabled) throw new Error("Bring! ist nicht verbunden – in der App unter Verwaltung → Einkaufslisten anmelden.");
    if (this.session && this.session.expires > Date.now()) return this.session;
    if (this.session?.refresh) {
      const res = await fetch(`${BASE}/v2/bringauth/token`, {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: this.session.refresh }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const b = (await res.json()) as { access_token: string; expires_in: number };
        this.session = { ...this.session, token: b.access_token, expires: Date.now() + (b.expires_in - 120) * 1000 };
        return this.session;
      }
    }
    this.session = await this.login();
    return this.session;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let s = await this.auth();
    const send = () => fetch(`${BASE}${path}`, {
      method,
      headers: { ...this.headers(s), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    let res = await send();
    if (res.status === 401) { this.session = null; s = await this.auth(); res = await send(); }
    if (!res.ok) throw new Error(`Bring!: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async lists(session?: Session): Promise<BringListInfo[]> {
    if (session) {
      const res = await fetch(`${BASE}/bringusers/${session.uuid}/lists`, { headers: this.headers(session), signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Bring!-Listen nicht lesbar (${res.status})`);
      return ((await res.json()) as { lists: BringListInfo[] }).lists.map((l) => ({ listUuid: l.listUuid, name: l.name }));
    }
    const s = await this.auth();
    const r = await this.call<{ lists: BringListInfo[] }>("GET", `/bringusers/${s.uuid}/lists`);
    return r.lists.map((l) => ({ listUuid: l.listUuid, name: l.name }));
  }

  async items(listUuid: string, includeDone = false): Promise<BringEntry[]> {
    const r = await this.call<{ items?: { purchase?: { uuid: string; itemId: string; specification?: string }[]; recently?: { uuid: string; itemId: string; specification?: string }[] } }>(
      "GET", `/v2/bringlists/${listUuid}`);
    const open = (r.items?.purchase ?? []).map((i) => ({ uuid: i.uuid, name: i.itemId, spec: i.specification ?? "", done: false }));
    const done = includeDone ? (r.items?.recently ?? []).map((i) => ({ uuid: i.uuid, name: i.itemId, spec: i.specification ?? "", done: true })) : [];
    return [...open, ...done];
  }

  private async change(listUuid: string, op: "TO_PURCHASE" | "TO_RECENTLY" | "REMOVE", name: string, spec = "", uuid = ""): Promise<void> {
    await this.call("PUT", `/v2/bringlists/${listUuid}/items`, {
      changes: [{ accuracy: "0.0", altitude: "0.0", latitude: "0.0", longitude: "0.0", itemId: name, spec, uuid, operation: op }],
      sender: "",
    });
  }

  async add(listUuid: string, name: string, spec = ""): Promise<void> {
    await this.change(listUuid, "TO_PURCHASE", name, spec);
    await this.notify(listUuid).catch(() => undefined);
  }

  async complete(listUuid: string, name: string, uuid = ""): Promise<void> {
    await this.change(listUuid, "TO_RECENTLY", name, "", uuid);
  }

  /** Andere Mitglieder der Liste per Bring!-Mitteilung informieren („Liste geändert“). */
  private async notify(listUuid: string): Promise<void> {
    const s = await this.auth();
    await this.call("POST", `/v2/bringnotifications/lists/${listUuid}`, {
      arguments: [], listNotificationType: "CHANGED_LIST", senderPublicUserUuid: s.publicUuid ?? "",
    });
  }
}
