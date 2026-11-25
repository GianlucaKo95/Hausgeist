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
import { ChatJobs } from "./chat-jobs.js";
import { Conversations } from "./conversations.js";
import { LongMemory } from "./long-memory.js";
import type { FinTSProvider } from "../adapters/payment.js";
import type { FritzBox } from "../adapters/fritzbox.js";
import type { WindowsPc } from "../adapters/pc.js";
import type { BringClient } from "../adapters/bring.js";
import { places, zoneAt, type Positions } from "./location.js";
import { logger } from "./log.js";
import { CHAT_PAGE } from "./chat-page.js";
import type { TvHub } from "./tv-hub.js";

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
export function startServer(config: Config, master: MasterAgent, finance: FinanceAgent, actions: ActionService, ha: HomeAssistant, settings: SettingsStore, fints: FinTSProvider, it: { fritz: FritzBox; pc: WindowsPc; positions: Positions; bring: BringClient; tv: TvHub }): void {
  const resolveUser = async (req: IncomingMessage): Promise<AppUser | null> => {
    const auth = req.headers.authorization ?? "";
    if (auth.startsWith("Bearer ")) return userFromSupabaseToken(auth.slice(7));
    // Ingress-Anfragen kommen nur vom Supervisor (172.30.32.2) und tragen die HA-Benutzer-ID.
    const fromSupervisor = (req.socket.remoteAddress ?? "").endsWith("172.30.32.2");
    const haUser = req.headers["x-remote-user-id"];
    if (fromSupervisor && typeof haUser === "string") return (await listUsers()).find((u) => u.ha_user_id === haUser) ?? null;
    return null;
  };

  const conversations = new Conversations(config.dataDir);
  // Alte Gespräche bekommen einmalig Themen-Titel (im Hintergrund)
  setTimeout(() => void conversations.backfillTitles(config).catch(() => undefined), 60_000);
  const memory = new LongMemory(config);
  listUsers().then((u) => memory.backfill(u)).catch(() => undefined);
  const jobs = new ChatJobs(async (job) => {
    const target = (await listUsers()).find((u) => u.id === job.userId);
    if (!target?.notify_service) return;
    const text = job.status === "done" ? job.reply ?? "" : `Das hat nicht geklappt: ${job.error}`;
    await ha.notify(target.notify_service, "Hausgeist", text.slice(0, 1500));
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(CHAT_PAGE);
        return;
      }
      if (path.endsWith("/api/health")) return json(res, 200, { ok: true, version: process.env.HAUSGEIST_VERSION ?? "dev" });

      // Couchpotato-Fernseher: eigene Geräteschlüssel statt Benutzeranmeldung
      if (path.includes("/api/tv/")) {
        const tv = it.tv;
        const tvPath = path.slice(path.indexOf("/api/tv/") + 7);
        if (req.method === "POST" && tvPath === "/pair") {
          const b = await readBody(req);
          try { return json(res, 200, tv.startPairing(String(b.name ?? ""), String(b.model ?? ""))); }
          catch (e) { return json(res, (e as { status?: number }).status ?? 400, { error: (e as Error).message }); }
        }
        const pm = tvPath.match(/^\/pair\/([\w-]{36})$/);
        if (req.method === "GET" && pm) return json(res, 200, tv.pollPairing(pm[1]));
        const dev = tv.authenticate(req.headers.authorization);
        if (!dev) return json(res, 401, { error: "Fernseher nicht gekoppelt" });
        if (req.method === "GET" && tvPath === "/next") {
          const wait = Math.min(Math.max(Number(url.searchParams.get("wait") ?? 25), 1), 30) * 1000;
          let closed = false;
          req.on("close", () => { closed = true; });
          const cmd = await tv.next(dev, wait);
          if (closed && cmd) { tv.result(dev, cmd.id, undefined, "Verbindung zum Fernseher abgebrochen"); return; }
          return cmd ? json(res, 200, cmd) : json(res, 200, { id: null, name: dev.name });
        }
        if (req.method === "POST" && tvPath === "/result") {
          const b = await readBody(req, 200_000);
          tv.result(dev, String(b.id ?? ""), b.result, typeof b.error === "string" ? b.error : undefined);
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: "Unbekannt" });
      }

      const user = await resolveUser(req);
      if (!user) return json(res, 401, { error: "Nicht angemeldet oder nicht als Haushaltsmitglied eingetragen." });

      if (req.method === "GET" && path.endsWith("/api/me")) return json(res, 200, { id: user.id, name: user.name, role: user.role });

      if (req.method === "POST" && path.endsWith("/api/reset")) {
        master.resetSession(user.id);
        conversations.startNew(user.id);
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
        // Gesprächsverlauf: Nachricht ins gewünschte bzw. aktuelle Gespräch, Antwort ebenso.
        const conv = await conversations.resolve(user.id, typeof body.conversation_id === "string" ? body.conversation_id : null,
          () => master.takeLegacySession(user.id));
        const shown = [message, ...attachments.map((a) => `📎 ${a.name}`)].filter(Boolean).join("\n");
        await conversations.add(conv, "me", shown);
        // Ältere Gespräche nicht samt aller Werkzeug-Ausgaben fortsetzen (teuer), sondern mit kurzem Textverlauf neu beginnen
        const fresh = conv.updated_at && Date.now() - Date.parse(conv.updated_at) < 20 * 60_000;
        let streamJob: { id: string } | null = null;
        const agentsUsed: string[] = [];
        const streaming = body.stream === true && body.async === true;
        const work = master.chat(user, message.slice(0, 8000), attachments, {
          id: fresh ? conv.session_id : null,
          save: (sid) => conversations.setSession(conv, sid),
          history: () => conversations.historyText(conv.id),
        }, {
          voice: body.voice === true,
          onAgent: (a) => agentsUsed.push(a),
          onText: streaming ? (d) => { if (streamJob) jobs.pushText(streamJob.id, d); } : undefined,
        }).then(
          async (reply) => {
            await conversations.add(conv, "ghost", reply).catch(() => undefined);
            // Langzeitgedächtnis im Hintergrund – gilt danach in jedem Gespräch
            memory.learn(user.id, user.name, message, reply, conv.id);
            void conversations.autoTitle(conv, config, agentsUsed).catch(() => undefined);
            return reply;
          },
          async (e) => { await conversations.add(conv, "error", e instanceof Error ? e.message : String(e)).catch(() => undefined); throw e; },
        );

        // App: Anfrage als Auftrag – läuft weiter, auch wenn die App in den Hintergrund geht.
        if (body.async === true) {
          const job = jobs.start(user.id, work);
          streamJob = job;
          // Sprachchat: sofort die Auftrags-ID, der Text kommt über /stream
          if (streaming) return json(res, 200, { pending: true, job_id: job.id, conversation_id: conv.id });
          const done = await jobs.wait(job.id, user.id, 25_000);
          if (done && done.status === "done") return json(res, 200, { reply: done.reply, job_id: job.id, conversation_id: conv.id });
          if (done && done.status === "error") return json(res, 500, { error: done.error, job_id: job.id, conversation_id: conv.id });
          return json(res, 200, { pending: true, job_id: job.id, conversation_id: conv.id });
        }

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

      // ── Standort aus der App (auch ohne VPN) ─────────────────────────
      if (req.method === "GET" && path.endsWith("/api/places")) {
        return json(res, 200, { places: places(await ha.states()) });
      }
      if (req.method === "POST" && path.endsWith("/api/location")) {
        const b = await readBody(req);
        const lat = Number(b.lat), lon = Number(b.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json(res, 400, { error: "Ungültige Position" });
        const zone = zoneAt({ lat, lon }, places(await ha.states().catch(() => [])));
        it.positions.update(user.id, { lat, lon, accuracy: Number(b.accuracy) || undefined }, zone);
        return json(res, 200, { ok: true, zone });
      }
      if (req.method === "POST" && path.endsWith("/api/location/zone")) {
        const b = await readBody(req);
        const event = b.event === "enter" ? "enter" : b.event === "leave" ? "leave" : null;
        if (!event || typeof b.zone !== "string") return json(res, 400, { error: "zone und event (enter/leave) angeben" });
        it.positions.zoneEvent(user.id, b.zone, event);
        return json(res, 200, { ok: true });
      }
      if (req.method === "DELETE" && path.endsWith("/api/location")) {
        it.positions.clear(user.id);
        return json(res, 200, { ok: true });
      }

      // ── Gedächtnis ansehen/löschen ───────────────────────────────────
      if (req.method === "GET" && path.endsWith("/api/memories")) {
        const { data } = await db().from("memories").select("id, text, updated_at").eq("user_id", user.id).order("updated_at", { ascending: false });
        return json(res, 200, { memories: data ?? [] });
      }
      const memMatch = path.match(/\/api\/memories\/([0-9a-f-]{36})$/);
      if (req.method === "DELETE" && memMatch) {
        await db().from("memories").delete().eq("id", memMatch[1]).eq("user_id", user.id);
        return json(res, 200, { ok: true });
      }
      if (req.method === "DELETE" && path.endsWith("/api/memories")) {
        await db().from("memories").delete().eq("user_id", user.id);
        return json(res, 200, { ok: true });
      }

      // ── Gesprächsverlauf ──────────────────────────────────────────────
      if (req.method === "GET" && path.endsWith("/api/conversations")) {
        return json(res, 200, { conversations: await conversations.list(user.id) });
      }
      const convMatch = path.match(/\/api\/conversations\/([0-9a-f-]{36})(\/open)?$/);
      if (convMatch && req.method === "GET") {
        const msgs = await conversations.messages(convMatch[1], user.id);
        return msgs ? json(res, 200, { messages: msgs }) : json(res, 404, { error: "Gespräch nicht gefunden" });
      }
      if (convMatch && convMatch[2] && req.method === "POST") {
        const c = await conversations.get(convMatch[1], user.id);
        if (!c) return json(res, 404, { error: "Gespräch nicht gefunden" });
        await conversations.resolve(user.id, c.id);
        return json(res, 200, { ok: true });
      }
      if (convMatch && req.method === "DELETE") {
        return (await conversations.remove(convMatch[1], user.id)) ? json(res, 200, { ok: true }) : json(res, 404, { error: "Gespräch nicht gefunden" });
      }

      const jobMatch = path.match(/\/api\/chat\/jobs\/([0-9a-f-]{36})$/);
      if (req.method === "GET" && jobMatch) {
        const wait = Math.min(Number(new URL(req.url ?? "/", "http://x").searchParams.get("wait") ?? 0) || 0, 25) * 1000;
        const job = await jobs.wait(jobMatch[1], user.id, wait);
        if (!job) return json(res, 404, { error: "Auftrag unbekannt (Hausgeist wurde evtl. neu gestartet)" });
        return json(res, 200, { status: job.status, reply: job.reply ?? null, error: job.error ?? null });
      }
      // Sprachchat: Antwort als Ereignisstrom (Server-Sent Events) – Text, sobald er entsteht
      const sm = path.match(/\/api\/chat\/jobs\/([\w-]{36})\/stream$/);
      if (req.method === "GET" && sm) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
        const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
        let unsub: (() => void) | undefined;
        const end = () => { clearInterval(ping); unsub?.(); res.end(); };
        unsub = jobs.subscribe(sm[1], user.id, (e) => { send(e); if (e.t !== "text") end(); });
        if (!unsub) { send({ t: "error", error: "Auftrag unbekannt" }); end(); }
        req.on("close", () => { clearInterval(ping); unsub?.(); });
        return;
      }
      if (req.method === "GET" && path.endsWith("/api/chat/jobs")) {
        return json(res, 200, { jobs: jobs.open(user.id).map((j) => ({ id: j.id, status: j.status })) });
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

      // Fernseher verwalten (Admin)
      if (path.includes("/api/admin/tvs")) {
        if (user.role !== "admin") return json(res, 403, { error: "Nur für den Admin." });
        const rest = path.slice(path.indexOf("/api/admin/tvs") + 14);
        try {
          if (req.method === "GET" && rest === "") return json(res, 200, { tvs: it.tv.list() });
          if (req.method === "POST" && rest === "/confirm") {
            const b = await readBody(req);
            const d = it.tv.confirm(String(b.code ?? ""), typeof b.name === "string" ? b.name : undefined);
            return json(res, 200, { id: d.id, name: d.name });
          }
          const m = rest.match(/^\/([\w-]{36})$/);
          if (m && req.method === "DELETE") { it.tv.remove(m[1]); return json(res, 200, { ok: true }); }
          if (m && req.method === "PUT") { const b = await readBody(req); it.tv.rename(m[1], String(b.name ?? "")); return json(res, 200, { ok: true }); }
        } catch (e) { return json(res, 400, { error: (e as Error).message }); }
        return json(res, 404, { error: "Unbekannt" });
      }

      if (await handleAdmin(req, res, path, user, { config, settings, ha, fints, fritz: it.fritz, pc: it.pc, bring: it.bring, json, readBody: (r) => readBody(r) })) return;

      json(res, 404, { error: "Nicht gefunden" });
    } catch (e) {
      log.error("Anfrage fehlgeschlagen", e);
      json(res, 500, { error: e instanceof Error ? e.message : "Fehler" });
    }
  });
  server.requestTimeout = 10 * 60_000;
  server.listen(8099, () => log.info("API auf Port 8099"));
}
