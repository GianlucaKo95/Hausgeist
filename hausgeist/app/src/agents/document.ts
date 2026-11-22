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

  keep(sha256: string, data: Buffer, mime = "application/pdf"): void {
    writeFileSync(this.path(sha256, mime), data);
  }

  private static readonly EXT: Record<string, string> = {
    "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  };

  private find(sha256: string): { path: string; ext: string } | null {
    for (const ext of Object.values(DocumentAgent.EXT)) {
      const p = join(this.inbox, `${sha256}.${ext}`);
      if (existsSync(p)) return { path: p, ext };
    }
    return null;
  }

  read(sha256: string): Buffer | null {
    const f = this.find(sha256);
    return f ? readFileSync(f.path) : null;
  }

  private path(sha256: string, mime: string): string {
    return join(this.inbox, `${sha256}.${DocumentAgent.EXT[mime] ?? "bin"}`);
  }

  /** Legt das Dokument ab. Gibt die Paperless-Task-ID zurück oder null, wenn Paperless nicht konfiguriert ist. */
  async file(sha256: string, meta: { title: string; tags: string[]; created?: string | null; filename: string; refId?: string }) {
    const found = this.find(sha256);
    if (!found) {
      log.debug(`Kein Dokument zu ${sha256} (z. B. Zahlung aus dem Chat)`);
      return null;
    }
    const pdf = readFileSync(found.path);
    if (!this.paperless.enabled) {
      log.warn("Paperless nicht konfiguriert – PDF bleibt im Posteingang des Add-ons");
      return null;
    }
    const tags = [...new Set(meta.tags.filter(Boolean))];
    const filename = /\.[a-z0-9]+$/i.test(meta.filename) ? meta.filename : `${meta.filename}.${found.ext}`;
    const taskId = await this.paperless.upload(pdf, filename, meta.title, tags, meta.created, found.ext);
    unlinkSync(found.path);
    await audit({ agent: "document", action: "file", level: 0, result: "ok", ref_table: "invoices", ref_id: meta.refId, detail: { taskId, tags } });
    log.info(`Abgelegt: ${meta.title}`);
    return taskId;
  }
}
