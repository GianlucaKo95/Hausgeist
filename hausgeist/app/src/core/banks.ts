import { FINTS_BANKS } from "../data/fints-banks.js";
import type { Config } from "./config.js";

/** Früher fest eingebaute Banken – Schlüssel bleiben gültig, damit bestehende Zugänge weiterlaufen. */
const LEGACY: Record<string, { name: string; url: string; blz: string }> = {
  sparkasse_duisburg: { name: "Sparkasse Duisburg", url: "https://banking-rl4.s-fints-pt-rl.de/fints30", blz: "35050000" },
  deutsche_bank: { name: "Deutsche Bank", url: "https://fints.deutsche-bank.de/", blz: "10070000" },
  dkb: { name: "DKB", url: "https://fints.dkb.de/fints", blz: "12030000" },
};

export interface DirectoryBank { blz: string; name: string; bic: string; url: string; location: string }

/**
 * Das Verzeichnis enthält Server, die es nicht mehr gibt (Volks-/Raiffeisenbanken und Sparda-Banken
 * sind zu Atruvia umgezogen, ING/DKB haben neue Adressen). Geprüft am 25.11.2026 per DNS.
 */
const ATRUVIA = "https://fints1.atruvia.de/cgi-bin/hbciservlet";
const MOVED_HOSTS: Record<string, string> = {
  "hbci11.fiducia.de": ATRUVIA,
  "hbci-pintan.gad.de": ATRUVIA,
  "fints.bankingonline.de": ATRUVIA,
  "fints.ing-diba.de": "https://fints.ing.de/fints/",
  "banking-dkb.s-fints-pt-dkb.de": "https://fints.dkb.de/fints",
};
const BLZ_URL: Record<string, string> = {
  "30060601": "https://fints.apobank.de/FinTs30PinTanHttpGate", // apoBank: eigener Server, nicht Atruvia
};

export function currentUrl(blz: string, url: string): string {
  if (BLZ_URL[blz]) return BLZ_URL[blz];
  try { return MOVED_HOSTS[new URL(url).hostname] ?? url; } catch { return url; }
}

export function bankByBlz(blz: string): DirectoryBank | null {
  const b = FINTS_BANKS[blz];
  return b ? { blz, name: b[0], bic: b[1], url: currentUrl(blz, b[2]), location: b[3] } : null;
}

/** Suche im Institutsverzeichnis nach Name, Ort, BIC oder Bankleitzahl. */
export function searchBanks(q: string, limit = 20): DirectoryBank[] {
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return [];
  const digits = needle.replace(/\s/g, "");
  const out: DirectoryBank[] = [];
  const seen = new Set<string>();
  for (const [blz, [name, bic, url, location]] of Object.entries(FINTS_BANKS)) {
    const hit = /^\d+$/.test(digits) ? blz.startsWith(digits)
      : `${name} ${location} ${bic}`.toLowerCase().includes(needle);
    if (!hit) continue;
    const fixed = currentUrl(blz, url);
    // Viele Filial-BLZ derselben Bank mit gleichem Server: nur einmal zeigen (außer bei BLZ-Suche)
    const key = /^\d+$/.test(digits) ? blz : `${name}|${fixed}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ blz, name, bic, url: fixed, location });
    if (out.length >= limit) break;
  }
  return out;
}

/** Schlüssel für einen neuen Bankzugang. */
export const keyForBlz = (blz: string) => `blz_${blz}`;

/** Name, Server und Bankleitzahl eines hinterlegten Zugangs (eigene Angaben > Verzeichnis > alte feste Liste). */
export function bankInfo(config: Config, key: string): { name: string; url: string; blz: string | null } {
  const login = config.bank_logins[key];
  const legacy = LEGACY[key];
  const blz = login?.blz ?? legacy?.blz ?? (key.match(/^blz_(\d{8})$/)?.[1] ?? null);
  const dir = blz ? bankByBlz(blz) : null;
  return {
    name: login?.name || legacy?.name || dir?.name || key,
    url: login?.url || legacy?.url || dir?.url || "",
    blz,
  };
}

/** Passender Bankzugang zu einer IBAN: gleiche Bankleitzahl, sonst gleicher FinTS-Server (Filialen). */
export function loginForIban(config: Config, iban: string): string | null {
  const clean = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^DE\d{20}$/.test(clean)) return null;
  const blz = clean.slice(4, 12);
  const keys = Object.keys(config.bank_logins);
  const exact = keys.find((k) => bankInfo(config, k).blz === blz);
  if (exact) return exact;
  const url = bankByBlz(blz)?.url;
  return url ? keys.find((k) => bankInfo(config, k).url === url) ?? null : null;
}
