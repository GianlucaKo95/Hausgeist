import { writeFileSync, renameSync, chmodSync } from "node:fs";
import { AppSettings, readAppSettings, settingsPath, type Config } from "./config.js";
import { logger } from "./log.js";

const log = logger("einstellungen");

type Key = keyof AppSettings;
type Listener = (changed: Key[]) => void | Promise<void>;

/**
 * Einstellungen aus der App. Sie werden direkt in das gemeinsame Config-Objekt
 * übernommen (alle Teile lesen live daraus) und auf dem Pi gespeichert –
 * Passwörter verlassen den Pi nicht.
 */
export class SettingsStore {
  private listeners: Listener[] = [];

  constructor(private readonly config: Config) {}

  onChange(l: Listener): void {
    this.listeners.push(l);
  }

  async update(patch: AppSettings): Promise<void> {
    const parsed = AppSettings.parse(patch);
    // Nur übernehmen, was wirklich gesendet wurde.
    const valid = Object.fromEntries(Object.entries(parsed).filter(([k]) => k in patch)) as AppSettings;
    const changed = Object.keys(valid) as Key[];
    if (changed.length === 0) return;
    Object.assign(this.config, valid);

    const current = readAppSettings(this.config.dataDir);
    const next = { ...current, ...valid };
    const path = settingsPath(this.config.dataDir);
    writeFileSync(`${path}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    try { chmodSync(path, 0o600); } catch { /* nicht kritisch */ }
    log.info(`Gespeichert: ${changed.join(", ")}`);

    for (const l of this.listeners) {
      try {
        await l(changed);
      } catch (e) {
        log.error("Neuladen nach Änderung fehlgeschlagen", e);
      }
    }
  }
}
