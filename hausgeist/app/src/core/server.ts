import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import type { AppUser } from "./checks.js";
import { listUsers } from "./db.js";
import type { MasterAgent } from "../agents/master.js";
import { logger } from "./log.js";
import { CHAT_PAGE } from "./chat-page.js";

const log = logger("server");

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64_000) throw new Error("Anfrage zu groß");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function tokenOk(given: string, expected: string): boolean {
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Chat-Eingang des Master-Agenten.
 * - Über Home-Assistant-Ingress (Seitenleiste): HA setzt X-Remote-User-Id.
 * - Für die eigene App über Port 8099: Authorization: Bearer <api_token> und X-Hausgeist-User: <users.id>.
 */
export function startServer(config: Config, master: MasterAgent): void {
  const resolveUser = async (req: IncomingMessage): Promise<AppUser | null> => {
    const users = await listUsers();
    const auth = req.headers.authorization ?? "";
    if (config.api_token && auth.startsWith("Bearer ") && tokenOk(auth.slice(7), config.api_token)) {
      const id = String(req.headers["x-hausgeist-user"] ?? "");
      return users.find((u) => u.id === id) ?? null;
    }
    // Ingress-Anfragen kommen nur vom Supervisor (172.30.32.2) und tragen die HA-Benutzer-ID.
    const fromSupervisor = (req.socket.remoteAddress ?? "").endsWith("172.30.32.2");
    const haUser = req.headers["x-remote-user-id"];
    if (fromSupervisor && typeof haUser === "string") return users.find((u) => u.ha_user_id === haUser) ?? null;
    return null;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(CHAT_PAGE);
        return;
      }
      if (url.pathname.endsWith("/api/health")) return json(res, 200, { ok: true });

      const user = await resolveUser(req);
      if (!user) return json(res, 401, { error: "Unbekannter Nutzer. In Supabase users.ha_user_id eintragen oder API-Token prüfen." });

      if (req.method === "GET" && url.pathname.endsWith("/api/me")) return json(res, 200, { name: user.name, role: user.role });
      if (req.method === "POST" && url.pathname.endsWith("/api/reset")) {
        master.resetSession(user.id);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname.endsWith("/api/chat")) {
        const body = await readBody(req);
        const message = String(body.message ?? "").trim();
        if (!message) return json(res, 400, { error: "message fehlt" });
        const reply = await master.chat(user, message.slice(0, 8000));
        return json(res, 200, { reply });
      }
      json(res, 404, { error: "Nicht gefunden" });
    } catch (e) {
      log.error("Anfrage fehlgeschlagen", e);
      json(res, 500, { error: e instanceof Error ? e.message : "Fehler" });
    }
  });
  server.requestTimeout = 10 * 60_000;
  server.listen(8099, () => log.info("Chat auf Port 8099 (Ingress)"));
}
