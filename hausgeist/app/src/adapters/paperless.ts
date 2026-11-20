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

  private async get<T>(path: string): Promise<T> {
    const base = this.config.paperless_url.replace(/\/$/, "");
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Token ${this.config.paperless_token}` } });
    if (!res.ok) throw new Error(`Paperless ${path}: ${res.status}`);
    return res.json() as Promise<T>;
  }

  /** Volltextsuche über alle Dokumente. */
  async search(query: string, limit = 10) {
    const r = await this.get<{ count: number; results: { id: number; title: string; created: string; tags: number[]; __search_hit__?: { highlights?: string } }[] }>(
      `/api/documents/?query=${encodeURIComponent(query)}&page_size=${limit}`,
    );
    return r.results.map((d) => ({ id: d.id, title: d.title, created: d.created, highlight: d.__search_hit__?.highlights ?? null }));
  }

  async document(id: number) {
    const d = await this.get<{ id: number; title: string; created: string; content: string }>(`/api/documents/${id}/`);
    return { id: d.id, title: d.title, created: d.created, content: d.content.slice(0, 20_000) };
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
