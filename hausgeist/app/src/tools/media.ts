import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { db } from "../core/db.js";
import { getUpload } from "../core/uploads.js";
import { formatEuro } from "../core/checks.js";
import { ok, safe, requireAdult, type ToolContext, type ToolResult } from "./context.js";

const LENS_BUCKET = "lens-temp";

/** Werkzeuge für Bilder und Reisen – für Research, Shopping und Document. */
export function viewUploadTool(ctx: ToolContext) {
  return tool("view_upload", "Ein in der App geschicktes Foto ansehen (upload_id aus der Nachricht).", {
    upload_id: z.string().uuid(),
  }, safe(async (a): Promise<ToolResult> => {
    const up = getUpload(a.upload_id);
    if (!up) throw new Error("Datei nicht gefunden");
    if (up.meta.userId !== ctx.user.id && ctx.user.role === "child") throw new Error("Keine Berechtigung");
    if (!up.meta.mime.startsWith("image/")) return ok("Das ist ein PDF – lies es mit den Dokument-Werkzeugen (process_upload/archive_upload).");
    return { content: [{ type: "image", data: up.data.toString("base64"), mimeType: up.meta.mime }, { type: "text", text: up.meta.name }] };
  }));
}

/**
 * Bildersuche über Google Lens (SerpAPI). Das Foto wird dafür kurz in einen
 * privaten Supabase-Speicher gelegt und per zeitlich begrenztem Link (10 Minuten)
 * übergeben, danach wieder gelöscht.
 */
export function reverseImageSearchTool(ctx: ToolContext) {
  return tool("reverse_image_search", "Bildersuche (Google Lens): findet Webseiten mit diesem oder ähnlichen Bildern, z. B. um ein Hotel oder Produkt zu identifizieren. Nur wenn ein serpapi_key konfiguriert ist.", {
    upload_id: z.string().uuid(),
  }, safe(async (a) => {
    if (!ctx.config.serpapi_key) return ok("Bildersuche ist nicht eingerichtet (serpapi_key fehlt). Nutze stattdessen view_upload und die Websuche.");
    const up = getUpload(a.upload_id);
    if (!up || !up.meta.mime.startsWith("image/")) throw new Error("Bild nicht gefunden");
    if (up.meta.userId !== ctx.user.id && ctx.user.role === "child") throw new Error("Keine Berechtigung");

    const storage = db().storage;
    const { data: buckets } = await storage.listBuckets();
    if (!buckets?.some((b) => b.name === LENS_BUCKET)) await storage.createBucket(LENS_BUCKET, { public: false });
    const path = `${a.upload_id}.${up.meta.mime.split("/")[1]}`;
    const { error: upErr } = await storage.from(LENS_BUCKET).upload(path, up.data, { contentType: up.meta.mime, upsert: true });
    if (upErr) throw upErr;
    try {
      const { data: signed, error } = await storage.from(LENS_BUCKET).createSignedUrl(path, 600);
      if (error || !signed) throw error ?? new Error("Kein Link");
      const q = new URLSearchParams({ engine: "google_lens", url: signed.signedUrl, hl: "de", country: "de", api_key: ctx.config.serpapi_key });
      const res = await fetch(`https://serpapi.com/search.json?${q}`);
      if (!res.ok) throw new Error(`Bildersuche: ${res.status}`);
      const j = (await res.json()) as { visual_matches?: { title?: string; link?: string; source?: string }[]; knowledge_graph?: { title?: string; subtitle?: string }[] };
      return ok({
        erkannt: (j.knowledge_graph ?? []).slice(0, 3).map((k) => ({ title: k.title, subtitle: k.subtitle })),
        treffer: (j.visual_matches ?? []).slice(0, 12).map((m) => ({ title: m.title, link: m.link, source: m.source })),
      });
    } finally {
      await storage.from(LENS_BUCKET).remove([path]);
    }
  }));
}

/** Hotel- oder Reisebuchung zur Freigabe vorlegen. Gebucht wird über den Link – nie mit gespeicherten Zahlungsdaten. */
export function bookingTool(ctx: ToolContext) {
  return tool("request_booking", "Hotel/Unterkunft/Reise zur Freigabe vorlegen (Stufe 2). Nach der Freigabe bekommt die Person die vorausgefüllten Buchungslinks; gebucht wird dort. Für eine Buchungsanfrage per Mail direkt ans Hotel stattdessen den Communication-Agenten nutzen.", {
    title: z.string().describe("z. B. Hotel Seeblick, Garmisch"),
    checkin: z.string().describe("JJJJ-MM-TT"),
    checkout: z.string().describe("JJJJ-MM-TT"),
    guests: z.string().describe("z. B. 2 Erwachsene, 1 Kind (5)"),
    total_euro: z.number().nonnegative().optional(),
    options: z.array(z.object({ provider: z.string(), price_euro: z.number().nonnegative().optional(), url: z.string().url() })).min(1),
    notes: z.string().optional().describe("Stornobedingungen, Frühstück, Besonderheiten"),
  }, safe(async (a) => {
    requireAdult(ctx);
    const cents = a.total_euro == null ? null : Math.round(a.total_euro * 100);
    const lines = a.options.map((o) => `• ${o.provider}${o.price_euro != null ? ` – ${formatEuro(Math.round(o.price_euro * 100))}` : ""}`);
    const summary = `${a.title}\n${a.checkin} bis ${a.checkout}, ${a.guests}${cents != null ? `\nca. ${formatEuro(cents)}` : ""}\n${lines.join("\n")}`;
    const r = await ctx.actions.request("booking", {
      title: a.title, checkin: a.checkin, checkout: a.checkout, guests: a.guests, total_cents: cents, options: a.options, notes: a.notes ?? null,
    } as never, { agent: "research", summary, requestedBy: ctx.user });
    return ok({ status: "Freigabe angefragt", an: r.approvers });
  }));
}
