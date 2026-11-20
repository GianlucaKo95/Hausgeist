import type { Config } from "../core/config.js";

/** Minimaler Client für die Paperless-ngx-API. */
export class Paperless {
  constructor(private readonly config: Config) {}

  get enabled(): boolean {
    return Boolean(this.config.paperless_url && this.config.paperless_token);
  }

  private async tagId(name: string): Promise<number> {
    const base = this.config.paperless_url.replace(/\/$/, "");
    const headers = { Authorization: `Token ${this.config.paperless_token}` };
    const found = await fetch(`${base}/api/tags/?name__iexact=${encodeURIComponent(name)}`, { headers });
    if (!found.ok) throw new Error(`Paperless Tags: ${found.status}`);
    const list = (await found.json()) as { results: { id: number }[] };
    if (list.results[0]) return list.results[0].id;
    const created = await fetch(`${base}/api/tags/`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!created.ok) throw new Error(`Paperless Tag anlegen: ${created.status}`);
    return ((await created.json()) as { id: number }).id;
  }

  /** Lädt ein PDF hoch. Paperless antwortet mit einer Task-ID (Verarbeitung läuft asynchron). */
  async upload(pdf: Buffer, filename: string, title: string, tags: string[], created?: string | null): Promise<string> {
    const base = this.config.paperless_url.replace(/\/$/, "");
    const form = new FormData();
    form.append("document", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), filename);
    form.append("title", title);
    if (created) form.append("created", created);
    for (const t of tags) form.append("tags", String(await this.tagId(t)));
    const res = await fetch(`${base}/api/documents/post_document/`, {
      method: "POST",
      headers: { Authorization: `Token ${this.config.paperless_token}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Paperless Upload: ${res.status} ${await res.text()}`);
    return String(await res.json()).replace(/"/g, "");
  }
}
