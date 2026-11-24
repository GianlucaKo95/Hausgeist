import { createHash, randomBytes } from "node:crypto";
import type { Config } from "../core/config.js";

/** Wert eines XML-Elements (einfaches Auslesen der TR-064-Antworten). */
export function xmlValue(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)</(?:\\w+:)?${tag}>`));
  return m ? decodeXml(m[1].trim()) : undefined;
}

function xmlItems(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

/** Antwort für HTTP-Digest-Authentifizierung (RFC 2617, qop=auth). */
export function digestHeader(opts: { user: string; password: string; method: string; uri: string; challenge: string; nc?: string; cnonce?: string }): string {
  const get = (k: string) => opts.challenge.match(new RegExp(`${k}="?([^",]+)"?`, "i"))?.[1] ?? "";
  const realm = get("realm");
  const nonce = get("nonce");
  const qop = get("qop") ? "auth" : "";
  const nc = opts.nc ?? "00000001";
  const cnonce = opts.cnonce ?? randomBytes(8).toString("hex");
  const ha1 = md5(`${opts.user}:${realm}:${opts.password}`);
  const ha2 = md5(`${opts.method}:${opts.uri}`);
  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  return `Digest username="${opts.user}", realm="${realm}", nonce="${nonce}", uri="${opts.uri}", response="${response}"`
    + (qop ? `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"` : "");
}

export interface FritzHost { name: string; ip: string; mac: string; active: boolean; connection: string }
export interface FritzCall { type: string; name: string; number: string; date: string; duration: string }

const CALL_TYPES: Record<string, string> = { "1": "eingehend", "2": "verpasst", "3": "ausgehend", "9": "eingehend (aktiv)", "10": "abgewiesen", "11": "ausgehend (aktiv)" };

/**
 * FRITZ!Box über TR-064 (offizielle AVM-Schnittstelle, Port 49000 im Heimnetz).
 * Benötigt einen FRITZ!Box-Benutzer mit dem Recht „FRITZ!Box Einstellungen“.
 */
export class FritzBox {
  private services: Map<string, string> | null = null;

  constructor(private readonly config: Config) {}

  get enabled(): boolean {
    return Boolean(this.config.fritzbox.user && this.config.fritzbox.password);
  }

  private get base(): string {
    return `http://${this.config.fritzbox.host || "fritz.box"}:49000`;
  }

  reset(): void {
    this.services = null;
  }

  /** Dienste und Steuer-URLs aus der Gerätebeschreibung. */
  private async serviceMap(): Promise<Map<string, string>> {
    if (this.services) return this.services;
    const res = await fetch(`${this.base}/tr64desc.xml`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`FRITZ!Box nicht erreichbar (${res.status})`);
    const xml = await res.text();
    const map = new Map<string, string>();
    for (const s of xmlItems(xml, "service")) {
      const type = xmlValue(s, "serviceType");
      const url = xmlValue(s, "controlURL");
      if (type && url) map.set(type, url);
    }
    this.services = map;
    return map;
  }

  private async findService(prefix: string): Promise<{ type: string; url: string }> {
    const map = await this.serviceMap();
    for (const [type, url] of map) if (type.startsWith(prefix)) return { type, url };
    throw new Error(`Die FRITZ!Box bietet ${prefix} nicht an`);
  }

  /** Gast-WLAN = WLANConfiguration mit der höchsten Nummer. */
  private async guestWlan(): Promise<{ type: string; url: string }> {
    const map = await this.serviceMap();
    const wlans = [...map].filter(([t]) => t.startsWith("urn:dslforum-org:service:WLANConfiguration:"))
      .sort(([a], [b]) => Number(a.split(":").pop()) - Number(b.split(":").pop()));
    if (wlans.length < 2) throw new Error("Kein Gast-WLAN gefunden");
    const [type, url] = wlans[wlans.length - 1];
    return { type, url };
  }

  async soap(service: { type: string; url: string }, action: string, args: Record<string, string> = {}): Promise<string> {
    if (!this.enabled) throw new Error("FRITZ!Box ist nicht eingerichtet – in der App unter Verwaltung → Netzwerk & PC eintragen.");
    const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
<s:Body><u:${action} xmlns:u="${service.type}">${Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join("")}</u:${action}></s:Body></s:Envelope>`;
    const headers: Record<string, string> = {
      "Content-Type": 'text/xml; charset="utf-8"',
      SOAPAction: `${service.type}#${action}`,
    };
    const send = (auth?: string) => fetch(`${this.base}${service.url}`, {
      method: "POST", body, headers: auth ? { ...headers, Authorization: auth } : headers, signal: AbortSignal.timeout(15000),
    });
    let res = await send();
    if (res.status === 401) {
      const challenge = res.headers.get("www-authenticate") ?? "";
      res = await send(digestHeader({
        user: this.config.fritzbox.user, password: this.config.fritzbox.password, method: "POST", uri: service.url, challenge,
      }));
    }
    const text = await res.text();
    if (res.status === 401) throw new Error("Die FRITZ!Box lehnt Benutzer oder Kennwort ab.");
    if (!res.ok) throw new Error(`FRITZ!Box: ${xmlValue(text, "errorDescription") ?? res.status}`);
    return text;
  }

  async info() {
    const xml = await this.soap(await this.findService("urn:dslforum-org:service:DeviceInfo:"), "GetInfo");
    return {
      model: xmlValue(xml, "NewModelName"),
      firmware: xmlValue(xml, "NewSoftwareVersion"),
      uptime_hours: Math.round(Number(xmlValue(xml, "NewUpTime") ?? 0) / 3600),
    };
  }

  async status() {
    const info = await this.info();
    const wan = await this.findService("urn:dslforum-org:service:WANCommonInterfaceConfig:");
    const link = await this.soap(wan, "GetCommonLinkProperties");
    let rates: { down_kbit?: number; up_kbit?: number } = {};
    try {
      const addon = await this.soap(wan, "X_AVM-DE_GetOnlineMonitor", { NewSyncGroupIndex: "0" });
      const last = (v?: string) => Number((v ?? "0").split(",")[0]) * 8 / 1000;
      rates = { down_kbit: Math.round(last(xmlValue(addon, "Newds_current_bps"))), up_kbit: Math.round(last(xmlValue(addon, "Newus_current_bps"))) };
    } catch { /* ältere Firmware */ }
    let ip: string | undefined;
    for (const p of ["urn:dslforum-org:service:WANPPPConnection:", "urn:dslforum-org:service:WANIPConnection:"]) {
      try { ip = xmlValue(await this.soap(await this.findService(p), "GetExternalIPAddress"), "NewExternalIPAddress"); if (ip) break; } catch { /* nächster */ }
    }
    return {
      ...info,
      internet: xmlValue(link, "NewPhysicalLinkStatus"),
      max_down_mbit: Math.round(Number(xmlValue(link, "NewLayer1DownstreamMaxBitRate") ?? 0) / 1e6),
      max_up_mbit: Math.round(Number(xmlValue(link, "NewLayer1UpstreamMaxBitRate") ?? 0) / 1e6),
      current: rates,
      external_ip: ip,
    };
  }

  async hosts(onlyActive = true): Promise<FritzHost[]> {
    const xml = await this.soap(await this.findService("urn:dslforum-org:service:Hosts:"), "X_AVM-DE_GetHostListPath");
    const path = xmlValue(xml, "NewX_AVM-DE_HostListPath");
    if (!path) throw new Error("Geräteliste nicht verfügbar");
    const list = await (await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(10000) })).text();
    return xmlItems(list, "Item").map((i) => ({
      name: xmlValue(i, "HostName") ?? "?",
      ip: xmlValue(i, "IPAddress") ?? "",
      mac: xmlValue(i, "MACAddress") ?? "",
      active: xmlValue(i, "Active") === "1",
      connection: xmlValue(i, "InterfaceType") ?? "",
    })).filter((h) => !onlyActive || h.active);
  }

  async wake(mac: string): Promise<void> {
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(mac)) throw new Error("MAC-Adresse ungültig (Format AA:BB:CC:DD:EE:FF)");
    await this.soap(await this.findService("urn:dslforum-org:service:Hosts:"), "X_AVM-DE_WakeOnLANByMACAddress", { NewMACAddress: mac.toUpperCase() });
  }

  async guestWifi() {
    const svc = await this.guestWlan();
    const info = await this.soap(svc, "GetInfo");
    const keys = await this.soap(svc, "GetSecurityKeys");
    const ssid = xmlValue(info, "NewSSID") ?? "";
    const password = xmlValue(keys, "NewKeyPassphrase") ?? "";
    return {
      enabled: xmlValue(info, "NewEnable") === "1",
      ssid,
      password,
      // Für QR-Codes (Kamera-App erkennt das Format)
      qr_text: `WIFI:T:WPA;S:${ssid};P:${password};;`,
    };
  }

  async setGuestWifi(enable: boolean): Promise<void> {
    await this.soap(await this.guestWlan(), "SetEnable", { NewEnable: enable ? "1" : "0" });
  }

  async calls(days: number): Promise<FritzCall[]> {
    const xml = await this.soap(await this.findService("urn:dslforum-org:service:X_AVM-DE_OnTel:"), "GetCallList");
    const url = xmlValue(xml, "NewCallListURL");
    if (!url) throw new Error("Anrufliste nicht verfügbar");
    const list = await (await fetch(`${url}&days=${days}`, { signal: AbortSignal.timeout(10000) })).text();
    return xmlItems(list, "Call").map((c) => {
      const type = xmlValue(c, "Type") ?? "";
      const incoming = ["1", "2", "9", "10"].includes(type);
      return {
        type: CALL_TYPES[type] ?? type,
        name: xmlValue(c, "Name") ?? "",
        number: (incoming ? xmlValue(c, "Caller") : xmlValue(c, "Called")) ?? "",
        date: xmlValue(c, "Date") ?? "",
        duration: xmlValue(c, "Duration") ?? "",
      };
    });
  }

  async reboot(): Promise<void> {
    await this.soap(await this.findService("urn:dslforum-org:service:DeviceConfig:"), "Reboot");
  }
}
