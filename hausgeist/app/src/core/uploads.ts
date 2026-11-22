import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Dateien, die über die App geschickt wurden (Fotos, Scans, PDFs). */
export interface Upload {
  id: string;
  name: string;
  mime: string;
  userId: string;
  createdAt: string;
}

let dir = "/data/uploads";

export function initUploads(dataDir: string): void {
  dir = join(dataDir, "uploads");
  mkdirSync(dir, { recursive: true });
}

export function saveUpload(data: Buffer, name: string, mime: string, userId: string): Upload {
  const meta: Upload = { id: randomUUID(), name, mime, userId, createdAt: new Date().toISOString() };
  writeFileSync(join(dir, `${meta.id}.bin`), data);
  writeFileSync(join(dir, `${meta.id}.json`), JSON.stringify(meta));
  return meta;
}

/** Liest eine Datei – nur für die Person, die sie hochgeladen hat, oder Erwachsene. */
export function getUpload(id: string): { meta: Upload; data: Buffer } | null {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const m = join(dir, `${id}.json`);
  if (!existsSync(m)) return null;
  return { meta: JSON.parse(readFileSync(m, "utf8")), data: readFileSync(join(dir, `${id}.bin`)) };
}
