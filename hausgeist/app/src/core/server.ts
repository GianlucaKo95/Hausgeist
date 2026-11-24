import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Config } from "./config.js";
import { canApprove, type AppUser } from "./checks.js";
import { db, listUsers } from "./db.js";
import type { MasterAgent, ChatAttachment } from "../agents/master.js";
import { saveUpload } from "./uploads.js";
import { isSupportedMime } from "../agents/extract.js";
import type { FinanceAgent } from "../agents/finance.js";
import type { ActionService } from "./actions.js";
import type { HomeAssistant } from "../adapters/homeassistant.js";
import type { SettingsStore } from "./settings.js";
import { handleAdmin } from "./admin-api.js";
import type { FinTSProvider } from "../adapters/payment.js";
import { logger } from "./log.js";
import { CHAT_PAGE } from "./chat-page.js";

const log = logger("server");

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 64_000): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("Anfrage zu groß");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

/** Kurzer Cache, damit nicht jede Anfrage Supabase Auth fragt. */
const tokenCache = new Map<string, { userId: string; until: number }>();

/**
 * Meldet eine Person über ihr Supabase-Login an. Beim ersten Login wird das
 * Auth-Konto über die E-Mail-Adresse mit public.users verknüpft.
 */
async function userFromSupabaseToken(token: string): Promise<AppUser | null> {
  const cached = tokenCache.get(token);
  const users = await listUsers();
  if (cached && cached.until > Date.now()) return users.find((u) => u.id === cached.userId) ?? null;

  const { data, error } = await db().auth.getUser(token);
  if (error || !data.user) return null;
  const authId = data.user.id;
  const email = data.user.email?.toLowerCase() ?? null;

  let { data: row } = await db().from("users").select("id").eq("auth_user_id", authId).maybeSingle();
  if (!row && email) {
    const { data: linked } = await db()
      .from("users")
      .update({ auth_user_id: authId })
      .eq("email", email)
      .is("auth_user_id", null)
      .select("id")
      .maybeSingle();
    row = linked;
    if (linked) log.info(`Login verknüpft: ${email}`);
  }
  if (!row) return null;
  tokenCache.set(token, { userId: row.id, until: Date.now() + 60_000 });
  const fresh = await listUsers();
  return fresh.find((u) => u.id === row!.id) ?? null;
}

/**
 * API für die Hausgeist-App (und Chat in der HA-Seitenleiste).
 * - App: Authorization: Bearer <Supabase-Access-Token>
 * - Ingress: Home Assistant setzt X-Remote-User-Id.
 */
export function startServer(config: Config, master: MasterAgent, finance: FinanceAgent, actions: ActionService, ha: HomeAssistant, settings: SettingsStore, fints: FinTSProvider): void {
  const resolveUser = async (req: IncomingMessage): Promise<AppUser | null> => {
    const auth = req.headers.authorization ?? "";
    if (auth.startsWith("Bearer ")) return userFromSupabaseToken(auth.slice(7));
    // Ingress-Anfragen kommen nur vom Supervisor (172.30.32.2) und tragen die HA-Benutzer-ID.
    const fromSupervisor = (req.socket.remoteAddress ?? "").endsWith("172.30.32.2");
    const haUser = req.headers["x-remote-user-id"];
    if (fromSupervisor && typeof haUser === "string") return (await listUsers()).find((u) => u.ha_user_id === haUser) ?? null;
    return null;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(CHAT_PAGE);
        return;
      }
      if (path.endsWith("/api/health")) return json(res, 200, { ok: true, version: "0.9.7" });

      const user = await resolveUser(req);
      if (!user) return json(res, 401, { error: "Nicht angemeldet oder nicht als Haushaltsmitglied eingetragen." });

      if (req.method === "GET" && path.endsWith("/api/me")) return json(res, 200, { id: user.id, name: user.name, role: user.role });

      if (req.method === "POST" && path.endsWith("/api/reset")) {
        master.resetSession(user.id);
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && path.endsWith("/api/chat")) {
        // Bis zu 5 Anhänge (Fotos, Scans, PDFs) à 10 MB, base64-kodiert.
        const body = await readBody(req, 75_000_000);
        const message = String(body.message ?? "").trim();
        const raw = Array.isArray(body.attachments) ? (body.attachments as { name?: string; mime?: string; data?: string }[]) : [];
        if (raw.length > 5) return json(res, 400, { error: "Höchstens 5 Anhänge" });
        const attachments: ChatAttachment[] = [];
        for (const a of raw) {
          const mime = String(a.mime ?? "");
          if (!isSupportedMime(mime)) return json(res, 400, { error: `Dateityp ${mime} wird nicht unterstützt (PDF, JPEG, PNG)` });
          const data = Buffer.from(String(a.data ?? ""), "base64");
          if (data.length === 0 || data.length > 10_000_000) return json(res, 400, { error: "Datei leer oder größer als 10 MB" });
          const name = String(a.name ?? "datei").replace(/[^\w.\- äöüÄÖÜß]+/g, "_").slice(0, 100);
          const up = saveUpload(data, name, mime, user.id);
          attachments.push({ uploadId: up.id, name, mime, data });
        }
        if (!message && attachments.length === 0) return json(res, 400, { error: "message fehlt" });
        const work = master.chat(user, message.slice(0, 8000), attachments);

        // Siri & Co. können nicht lange warten: nach 20 s kommt die Antwort per Mitteilung.
        if (body.push_if_slow === true) {
          const timeout = new Promise<null>((r) => setTimeout(() => r(null), 20_000));
          const reply = await Promise.race([work, timeout]);
          if (reply !== null) return json(res, 200, { reply });
          work.then(async (r) => {
            if (user.notify_service) await ha.notify(user.notify_service, "Hausgeist", r.slice(0, 1500));
          }).catch((e) => log.error("Späte Antwort fehlgeschlagen", e));
          return json(res, 200, { reply: "Das dauert etwas länger – ich schicke dir die Antwort als Mitteilung.", pending: true });
        }
        return json(res, 200, { reply: await work });
      }

      if (req.method === "GET" && path.endsWith("/api/approvals")) {
        if (user.role === "child") return json(res, 200, { payments: [], actions: [] });
        const [{ data: pays }, { data: acts }] = await Promise.all([
          db().from("approvals")
            .select("id, amount_cents, iban, reference, payee_status, created_at, accounts(label), invoices(issuer, due_date, recipient_name, review_note)")
            .eq("status", "pending").order("created_at"),
          db().from("actions").select("id, kind, summary, amount_cents, payload, created_at").eq("status", "pending").order("created_at"),
        ]);
        const payments = (pays ?? []).map((p) => {
          const inv = p.invoices as unknown as { issuer: string; due_date: string | null; recipient_name: string | null; review_note: string | null } | null;
          const acc = p.accounts as unknown as { label: string } | null;
          return {
            id: p.id, issuer: inv?.issuer ?? "?", amount_cents: p.amount_cents, iban: p.iban, reference: p.reference,
            payee_status: p.payee_status, due_date: inv?.due_date ?? null, recipient_name: inv?.recipient_name ?? null,
            note: inv?.review_note ?? null, account: acc?.label ?? null, created_at: p.created_at,
            can_decide: canApprove(user, { amount_cents: p.amount_cents, payee_status: p.payee_status }).allowed,
          };
        });
        const actionList = [];
        for (const a of acts ?? []) {
          actionList.push({
            id: a.id, kind: a.kind, summary: a.summary, amount_cents: a.amount_cents, created_at: a.created_at,
            can_decide: await actions.canDecide(user, a),
          });
        }
        return json(res, 200, { payments, actions: actionList });
      }

      // ── Geräte für Push-Nachrichten ──
      if (path.endsWith("/api/devices") && (req.method === "POST" || req.method === "DELETE")) {
        const body = await readBody(req);
        const token = String(body.token ?? "");
        if (!/^[0-9a-f]{64,200}$/i.test(token)) return json(res, 400, { error: "Ungültiges Geräte-Token" });
        if (req.method === "DELETE") {
          await db().from("push_devices").delete().eq("token", token).eq("user_id", user.id);
          return json(res, 200, { ok: true });
        }
        const environment = body.environment === "sandbox" ? "sandbox" : "production";
        const { error } = await db().from("push_devices").upsert(
          { token, environment, user_id: user.id, platform: "ios", updated_at: new Date().toISOString() },
          { onConflict: "token" },
        );
        if (error) throw error;
        return json(res, 200, { ok: true });
      }

      // ── Knopf direkt in der Mitteilung (Freigeben/Ablehnen) ──
      if (req.method === "POST" && path.endsWith("/api/push-action")) {
        const body = await readBody(req);
        const action = String(body.action ?? "");
        const pm = action.match(/^(HG_APPROVE|HG_REJECT|HG_ACT_OK|HG_ACT_NO):([0-9a-f-]{36})$/);
        if (!pm) return json(res, 400, { error: "Unbekannte Aktion" });
        const approve = pm[1] === "HG_APPROVE" || pm[1] === "HG_ACT_OK";
        const r = pm[1].startsWith("HG_ACT") ? await actions.decide(user, pm[2], approve) : await finance.decide(user, pm[2], approve);
        return json(res, r.ok ? 200 : 409, r);
      }

      const m = path.match(/\/api\/approvals\/(payment|action)\/([0-9a-f-]{36})$/);
      if (req.method === "POST" && m) {
        const body = await readBody(req);
        if (typeof body.approve !== "boolean") return json(res, 400, { error: "approve (true/false) fehlt" });
        const r = m[1] === "payment" ? await finance.decide(user, m[2], body.approve) : await actions.decide(user, m[2], body.approve);
        return json(res, r.ok ? 200 : 409, r);
      }

      if (await handleAdmin(req, res, path, user, { config, settings, ha, fints, json, readBody: (r) => readBody(r) })) return;

      json(res, 404, { error: "Nicht gefunden" });
    } catch (e) {
      log.error("Anfrage fehlgeschlagen", e);
      json(res, 500, { error: e instanceof Error ? e.message : "Fehler" });
    }
  });
  server.requestTimeout = 10 * 60_000;
  server.listen(8099, () => log.info("API auf Port 8099"));
}
