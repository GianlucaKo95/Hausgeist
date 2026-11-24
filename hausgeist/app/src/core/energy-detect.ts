/**
 * Findet die Energie-Sensoren selbst: zuerst über das Energie-Dashboard von Home Assistant
 * (welche Zähler sind PV, Speicher, Netz), dann den passenden Leistungs-Sensor (W) am selben Gerät.
 * Ohne Dashboard-Eintrag greifen Namensregeln (deutsch/englisch, gängige Wechselrichter).
 */
export type EnergyKey = "pv_power" | "battery_soc" | "battery_power" | "grid_power" | "house_power";
export type EnergyPick = Partial<Record<EnergyKey, string>>;

type State = { entity_id: string; state: string; attributes: Record<string, unknown> };
type RegEntry = { entity_id: string; device_id: string | null; disabled_by?: string | null };
export interface EnergyPrefs {
  energy_sources?: {
    type: string;
    stat_energy_from?: string;
    stat_energy_to?: string;
    flow_from?: { stat_energy_from: string }[];
    flow_to?: { stat_energy_to: string }[];
  }[];
}

const RULES: Record<EnergyKey, { want: RegExp; avoid: RegExp }> = {
  pv_power: {
    want: /(pv|solar|photovoltai|wechselrichter|inverter|erzeugung|production|yield|input_power|dc_power|mppt|hoymiles|opendtu|ahoy)/,
    avoid: /(forecast|prognose|vorhersage|energy|energie|today|heute|kwh|batter|speicher|akku|grid|netz|einspeis|bezug|export|import|meter|verbrauch|consumption|load|limit|max|peak)/,
  },
  battery_power: {
    want: /(batter|speicher|akku|storage|charge_discharge|lade_?leistung|ladeleistung|battery_power|solix|zendure|ecoflow)/,
    avoid: /(soc|state_of_charge|ladezustand|level|capacity|kapazit|energy|energie|today|kwh|voltage|spannung|current|strom|temperature|temp|health|max|limit)/,
  },
  battery_soc: {
    want: /(soc|state_of_charge|ladezustand|speicher|batter|akku|storage|battery_level)/,
    avoid: /(phone|iphone|ipad|watch|airpods|remote|fernbed|tür|tuer|door|window|fenster|motion|bewegung|button|taster|thermostat|heizkörper|sensor_?batt|rauchmelder|smoke|leak|tag|keyfob|car|auto|mg5|ioniq|tesla|_low)/,
  },
  grid_power: {
    want: /(grid|netz|einspeis|bezug|meter|zähler|zaehler|smartmeter|smart_meter|hausanschluss|tibber|shelly_?3?em|power_meter|active_power|wirkleistung)/,
    avoid: /(pv|solar|batter|speicher|energy|energie|today|kwh|frequency|frequenz|voltage|spannung|current|strom|limit|max|phase_?[abc123]\b|_l[123]\b)/,
  },
  house_power: {
    want: /(haus|house|home|verbrauch|consumption|load|last|eigenverbrauch)/,
    avoid: /(energy|energie|today|kwh|forecast|prognose|batter|pv|solar|_l[123]\b|max)/,
  },
};

const text = (s: State) => `${s.entity_id} ${String(s.attributes.friendly_name ?? "")}`.toLowerCase();
const numeric = (s: State) => s.state !== "unavailable" && s.state !== "unknown" && Number.isFinite(Number(s.state));
const isPower = (s: State) => s.entity_id.startsWith("sensor.") && (s.attributes.device_class === "power" || /^(k?W)$/.test(String(s.attributes.unit_of_measurement ?? "")));
const isSoc = (s: State) => s.entity_id.startsWith("sensor.") && String(s.attributes.unit_of_measurement ?? "") === "%"
  && (s.attributes.device_class === "battery" || /(soc|state_of_charge|ladezustand)/.test(text(s)));

function score(s: State, key: EnergyKey, deviceHint: Set<string> | undefined, deviceOf: Map<string, string | null>): number {
  const t = text(s);
  const r = RULES[key];
  let sc = 0;
  if (r.want.test(t)) sc += 10;
  if (r.avoid.test(t)) sc -= 15;
  if (deviceHint?.has(deviceOf.get(s.entity_id) ?? "")) sc += 20; // gleiches Gerät wie der Dashboard-Zähler
  if (numeric(s)) sc += 2;
  return sc;
}

/** Bestes Paar je Kategorie plus die nächstbesten Kandidaten (zur Kontrolle). */
export function detectEnergy(states: State[], registry: RegEntry[] = [], prefs: EnergyPrefs = {}) {
  const deviceOf = new Map(registry.map((e) => [e.entity_id, e.device_id]));
  const hint: Partial<Record<EnergyKey, Set<string>>> = {};
  const add = (k: EnergyKey, id?: string) => {
    const d = id ? deviceOf.get(id) : null;
    if (d) (hint[k] ??= new Set()).add(d);
  };
  for (const src of prefs.energy_sources ?? []) {
    if (src.type === "solar") add("pv_power", src.stat_energy_from);
    if (src.type === "battery") { add("battery_power", src.stat_energy_from); add("battery_power", src.stat_energy_to); add("battery_soc", src.stat_energy_from); }
    if (src.type === "grid") {
      for (const f of src.flow_from ?? []) add("grid_power", f.stat_energy_from);
      for (const f of src.flow_to ?? []) add("grid_power", f.stat_energy_to);
    }
  }

  const disabled = new Set(registry.filter((e) => e.disabled_by).map((e) => e.entity_id));
  const pick: EnergyPick = {};
  const candidates: Partial<Record<EnergyKey, { entity_id: string; name: string; state: string; unit: string }[]>> = {};
  for (const key of Object.keys(RULES) as EnergyKey[]) {
    const pool = states.filter((s) => !disabled.has(s.entity_id) && (key === "battery_soc" ? isSoc(s) : isPower(s)));
    const ranked = pool.map((s) => ({ s, sc: score(s, key, hint[key], deviceOf) })).filter((x) => x.sc >= 10).sort((a, b) => b.sc - a.sc);
    candidates[key] = ranked.slice(0, 5).map(({ s }) => ({
      entity_id: s.entity_id, name: String(s.attributes.friendly_name ?? s.entity_id), state: s.state, unit: String(s.attributes.unit_of_measurement ?? ""),
    }));
    if (ranked[0]) pick[key] = ranked[0].s.entity_id;
  }
  return { pick, candidates, fromDashboard: Object.keys(hint).length > 0 };
}

/** Alles Nötige aus Home Assistant holen und erkennen. */
export async function detectFromHa(ha: {
  states(): Promise<State[]>;
  wsCommand<T>(type: string, extra?: Record<string, unknown>): Promise<T>;
}) {
  const [states, registry, prefs] = await Promise.all([
    ha.states(),
    ha.wsCommand<RegEntry[]>("config/entity_registry/list").catch(() => []),
    ha.wsCommand<EnergyPrefs>("energy/get_prefs").catch(() => ({})),
  ]);
  return detectEnergy(states, registry, prefs ?? {});
}
