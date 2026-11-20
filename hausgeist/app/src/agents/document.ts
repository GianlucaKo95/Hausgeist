import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../core/config.js";
import { Paperless } from "../adapters/paperless.js";
import { audit } from "../core/db.js";
import { logger } from "../core/log.js";

const log = logger("document");

/**
 * Document-Agent, Phase 1: hält PDFs bis zur Entscheidung lokal vor und legt
 * sie anschließend in Paperless-ngx ab.
 */
export class DocumentAgent {
  private readonly inbox: string;
  private readonly paperless: Paperless;

  constructor(config: Config) {
    this.inbox = join(config.dataDir, "inbox");
    mkdirSync(this.inbox, { recursive: true });
    this.paperless = new Paperless(config);
  }

  keep(sha256: string, pdf: Buffer): void {
    writeFileSync(this.path(sha256), pdf);
  }

  read(sha256: string): Buffer | null {
    const p = this.path(sha256);
    return existsSync(p) ? readFileSync(p) : null;
  }

  private path(sha256: string): string {
    return join(this.inbox, `${sha256}.pdf`);
  }

  /** Legt das Dokument ab. Gibt die Paperless-Task-ID zurück oder null, wenn Paperless nicht konfiguriert ist. */
  async file(sha256: string, meta: { title: string; tags: string[]; created?: string | null; filename: string; refId?: string }) {
    const pdf = this.read(sha256);
    if (!pdf) {
      log.warn(`PDF ${sha256} nicht mehr vorhanden`);
      return null;
    }
    if (!this.paperless.enabled) {
      log.warn("Paperless nicht konfiguriert – PDF bleibt im Posteingang des Add-ons");
      return null;
    }
    const tags = [...new Set(meta.tags.filter(Boolean))];
    const taskId = await this.paperless.upload(pdf, meta.filename, meta.title, tags, meta.created);
    unlinkSync(this.path(sha256));
    await audit({ agent: "document", action: "file", level: 0, result: "ok", ref_table: "invoices", ref_id: meta.refId, detail: { taskId, tags } });
    log.info(`Abgelegt: ${meta.title}`);
    return taskId;
  }
}
