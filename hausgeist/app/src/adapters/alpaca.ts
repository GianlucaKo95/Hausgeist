/**
 * Alpaca – NUR Paper-Trading. Die Live-Adresse ist hier bewusst nicht vorhanden und
 * Live-Schlüssel (beginnen mit „AK“) werden abgelehnt: echte Orders sind ausgeschlossen.
 */
const PAPER = "https://paper-api.alpaca.markets";
const DATA = "https://data.alpaca.markets";

export interface Bar { t: string; o: number; h: number; l: number; c: number; v: number }
export interface AlpacaPosition { symbol: string; qty: string; avg_entry_price: string; current_price: string; unrealized_pl: string; market_value: string }

export class AlpacaPaper {
  constructor(private keys: () => { key_id: string; secret: string }) {}

  get enabled(): boolean { const k = this.keys(); return Boolean(k.key_id && k.secret); }

  private headers(): Record<string, string> {
    const k = this.keys();
    if (!k.key_id || !k.secret) throw new Error("Alpaca-Schlüssel fehlen – in der App unter Verwaltung → Trading eintragen");
    if (!k.key_id.startsWith("PK")) throw new Error("Nur Paper-Schlüssel (beginnen mit PK) sind erlaubt – Live-Handel ist im Hausgeist ausgeschlossen");
    return { "APCA-API-KEY-ID": k.key_id, "APCA-API-SECRET-KEY": k.secret, "Content-Type": "application/json" };
  }

  private async call<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...this.headers(), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new Error("Alpaca lehnt die Schlüssel ab – Paper-Schlüssel prüfen");
    if (!res.ok) throw new Error(`Alpaca ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  clock() { return this.call<{ timestamp: string; is_open: boolean; next_open: string; next_close: string }>(PAPER, "/v2/clock"); }
  account() { return this.call<{ equity: string; last_equity: string; cash: string; buying_power: string; status: string }>(PAPER, "/v2/account"); }
  positions() { return this.call<AlpacaPosition[]>(PAPER, "/v2/positions"); }

  /** Marktorder über einen Dollarbetrag (Bruchstücke erlaubt). */
  buyNotional(symbol: string, usd: number, clientId: string) {
    return this.call<{ id: string; status: string }>(PAPER, "/v2/orders", {
      method: "POST",
      body: JSON.stringify({ symbol, notional: usd.toFixed(2), side: "buy", type: "market", time_in_force: "day", client_order_id: clientId }),
    });
  }
  closePosition(symbol: string) { return this.call<{ id: string }>(PAPER, `/v2/positions/${encodeURIComponent(symbol)}`, { method: "DELETE" }); }
  closeAll() { return this.call<unknown>(PAPER, "/v2/positions?cancel_orders=true", { method: "DELETE" }); }

  /** Ausführungen eines Tages (für die Abendauswertung). */
  fills(date: string) {
    return this.call<{ symbol: string; side: string; qty: string; price: string; transaction_time: string; order_id: string }[]>(PAPER, `/v2/account/activities/FILL?date=${date}&direction=asc&page_size=100`);
  }

  /** 1-Minuten-Kerzen (Börse IEX, im Gratis-Tarif in Echtzeit). */
  async bars(symbols: string[], startIso: string, timeframe = "1Min"): Promise<Record<string, Bar[]>> {
    const out: Record<string, Bar[]> = {};
    let token: string | undefined;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ symbols: symbols.join(","), timeframe, start: startIso, limit: "10000", feed: "iex", adjustment: "raw" });
      if (token) q.set("page_token", token);
      const r = await this.call<{ bars: Record<string, Bar[]> | null; next_page_token: string | null }>(DATA, `/v2/stocks/bars?${q}`);
      for (const [s, b] of Object.entries(r.bars ?? {})) (out[s] ??= []).push(...b);
      token = r.next_page_token ?? undefined;
      if (!token) break;
    }
    return out;
  }
}
