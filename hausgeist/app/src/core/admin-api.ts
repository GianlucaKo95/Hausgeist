import type { IncomingMessage, ServerResponse } from "node:http";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { z } from "zod";
import type { Config, MailboxConfig } from "./config.js";
import type { SettingsStore } from "./settings.js";
import { isValidIban, normalizeIban, type AppUser } from "./checks.js";
import { db, audit } from "./db.js";
import { AppleCalendar } from "../adapters/calendar.js";
import type { HomeAssistant } from "../adapters/homeassistant.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;
type ReadBody = (req: IncomingMessage) => Promise<Record<string, unknown>>;

export interface AdminDeps {
  config: Config;
  settings: SettingsStore;
  ha: HomeAssistant;
  json: Json;
  readBody: ReadBody;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const requireAdmin = (u: AppUser) => { if (u.role !== "admin") throw new HttpError(403, "Nur für den Admin."); };
const requireAdult = (u: AppUser) => { if (u.role === "child") throw new HttpError(403, "Keine Berechtigung."); };

const time = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d)?$/, "Uhrzeit im Format HH:MM");

const SettingsBody = z.object({
  icloud_user: z.string().optional(),
  icloud_app_password: z.string().optional(),
  calendars: z.array(z.object({ name: z.string().min(1), owner: z.string().min(1) })).optional(),
  calendar_feeds: z.array(z.object({ name: z.string().min(1), url: z.string().regex(/^(https?|webcal):\/\//, "Link muss mit https:// oder webcal:// beginnen"), owner: z.string().default("shared") })).optional(),
  ha_calendars: z.array(z.object({ name: z.string().min(1), entity_id: z.string().regex(/^calendar\.[a-z0-9_]+$/), owner: z.string().default("shared") })).optional(),
  ha_entities: z.array(z.string().min(1)).optional(),
  energy: z.object({
    pv_power: z.string().optional(), battery_soc: z.string().optional(), battery_power: z.string().optional(),
    grid_power: z.string().optional(), house_power: z.string().optional(),
  }).optional(),
  daily_brief: time.optional(),
  evening_check: time.optional(),
  mail_triage: z.boolean().optional(),
  weekly_offers: z.boolean().optional(),
  calendar_insights: z.boolean().optional(),
  paperless_url: z.string().optional(),
  paperless_token: z.string().optional(),
});

const MailboxBody = z.object({
  original_name: z.string().optional(),
  name: z.string().regex(/^[\w\- äöüÄÖÜß]{1,40}$/, "Name: Buchstaben, Ziffern, Leerzeichen, - und _"),
  host: z.string().min(3),
  port: z.number().int().min(1).max(65535),
  tls: z.boolean(),
  user: z.string().min(1),
  password: z.string().optional(),
  folder: z.string().optional(),
  smtp_host: z.string().optional(),
  smtp_port: z.number().int().min(1).max(65535).optional(),
  from_name: z.string().optional(),
  owner_id: z.string().uuid().nullable().optional(),
  visibility: z.enum(["private", "shared"]),
  scope: z.enum(["private", "business"]),
});

const UserBody = z.object({
  name: z.string().min(1).max(40),
  role: z.enum(["admin", "adult", "child"]),
  email: z.string().email().nullable().optional(),
  approval_limit_euro: z.number().min(0).max(100_000).optional(),
});

const AccountBody = z.object({
  label: z.string().min(1),
  bank: z.enum(["sparkasse_duisburg", "deutsche_bank", "dkb"]),
  iban: z.string(),
  holder_id: z.string().uuid().nullable().optional(),
  match_names: z.array(z.string()).default([]),
  is_default: z.boolean().default(false),
});

const PayeeBody = z.object({ name: z.string().min(1), iban: z.string(), default_account_id: z.string().uuid().nullable().optional() });

async function imapTest(mb: { host: string; port: number; tls: boolean; user: string; password: string }): Promise<string[]> {
  const c = new ImapFlow({ host: mb.host, port: mb.port, secure: mb.tls, auth: { user: mb.user, pass: mb.password }, logger: false });
  await c.connect();
  try {
    const list = await c.list();
    return list.map((f) => f.path).slice(0, 50);
  } finally {
    await c.logout().catch(() => undefined);
  }
}

/**
 * Verwaltung aus der App: Personen, Postfächer, Kalender, Konten, Empfänger,
 * Smart Home und Routinen. Gibt true zurück, wenn die Anfrage behandelt wurde.
 */
export async function handleAdmin(req: IncomingMessage, res: ServerResponse, path: string, user: AppUser, d: AdminDeps): Promise<boolean> {
  const m = path.match(/\/api\/admin\/(.+)$/);
  if (!m) return false;
  const route = m[1];
  const method = req.method ?? "GET";
  const { config, json } = d;

  try {
    // ── Einstellungen ────────────────────────────────────────────────────
    if (route === "settings" && method === "GET") {
      requireAdmin(user);
      json(res, 200, {
        icloud_user: config.icloud_user, icloud_password_set: Boolean(config.icloud_app_password),
        calendars: config.calendars, calendar_feeds: config.calendar_feeds, ha_calendars: config.ha_calendars,
        ha_entities: config.ha_entities, energy: config.energy,
        daily_brief: config.daily_brief, evening_check: config.evening_check, mail_triage: config.mail_triage,
        weekly_offers: config.weekly_offers, calendar_insights: config.calendar_insights,
        paperless_url: config.paperless_url, paperless_token_set: Boolean(config.paperless_token),
        push_enabled: Boolean(config.apns_key_id && config.apns_key),
      });
      return true;
    }
    if (route === "settings" && method === "PUT") {
      requireAdmin(user);
      const body = SettingsBody.parse(await d.readBody(req));
      // Leere Passwortfelder bedeuten „unverändert lassen“.
      if (body.icloud_app_password === "") delete body.icloud_app_password;
      if (body.paperless_token === "") delete body.paperless_token;
      await d.settings.update(body);
      await audit({ agent: "admin", action: "settings", level: 1, result: Object.keys(body).join(","), user_id: user.id });
      json(res, 200, { ok: true });
      return true;
    }
    if (route === "icloud/test" && method === "POST") {
      requireAdmin(user);
      const body = z.object({ icloud_user: z.string().optional(), icloud_app_password: z.string().optional() }).parse(await d.readBody(req));
      const temp = new AppleCalendar({
        ...config,
        icloud_user: body.icloud_user || config.icloud_user,
        icloud_app_password: body.icloud_app_password || config.icloud_app_password,
      });
      if (!temp.enabled) throw new HttpError(400, "Apple-ID und App-Passwort fehlen");
      try {
        json(res, 200, { ok: true, calendars: await temp.listCalendars() });
      } catch (e) {
        throw new HttpError(400, `Anmeldung bei iCloud fehlgeschlagen: ${e instanceof Error ? e.message : e}. App-spezifisches Passwort verwenden.`);
      }
      return true;
    }

    // ── Postfächer ───────────────────────────────────────────────────────
    if (route === "mailboxes" && method === "GET") {
      requireAdult(user);
      const { data: meta } = await db().from("mailboxes").select("name, owner_id, visibility, scope");
      const byName = new Map((meta ?? []).map((x) => [x.name as string, x]));
      const list = config.mailboxes
        .map((mb) => ({ ...mb, password: undefined, password_set: Boolean(mb.password), ...(byName.get(mb.name) ?? { owner_id: null, visibility: "shared", scope: "private" }) }))
        .filter((mb) => user.role === "admin" || mb.owner_id === user.id);
      json(res, 200, list);
      return true;
    }
    if (route === "mailboxes" && method === "PUT") {
      requireAdult(user);
      const b = MailboxBody.parse(await d.readBody(req));
      if (user.role !== "admin") b.owner_id = user.id; // Erwachsene verwalten nur eigene Postfächer
      const original = b.original_name ?? b.name;
      const existing = config.mailboxes.find((x) => x.name === original);
      if (existing && user.role !== "admin") {
        const { data: own } = await db().from("mailboxes").select("owner_id").eq("name", original).maybeSingle();
        if (own?.owner_id !== user.id) throw new HttpError(403, "Nur eigene Postfächer.");
      }
      if (b.name !== original && config.mailboxes.some((x) => x.name === b.name)) throw new HttpError(409, "Name ist schon vergeben");
      const password = b.password || existing?.password;
      if (!password) throw new HttpError(400, "Passwort fehlt");
      const mb: MailboxConfig = {
        name: b.name, host: b.host, port: b.port, tls: b.tls, user: b.user, password,
        folder: b.folder || undefined, smtp_host: b.smtp_host || undefined, smtp_port: b.smtp_port, from_name: b.from_name || undefined,
      };
      const next = [...config.mailboxes.filter((x) => x.name !== original), mb];
      if (original !== b.name) await db().from("mailboxes").update({ name: b.name }).eq("name", original);
      const { error } = await db().from("mailboxes").upsert(
        { name: b.name, owner_id: b.owner_id ?? null, visibility: b.visibility, scope: b.scope }, { onConflict: "name" });
      if (error) throw error;
      await d.settings.update({ mailboxes: next });
      await audit({ agent: "admin", action: "mailbox_saved", level: 1, result: b.name, user_id: user.id });
      json(res, 200, { ok: true });
      return true;
    }
    const mbDel = route.match(/^mailboxes\/(.+)$/);
    if (mbDel && method === "DELETE") {
      requireAdult(user);
      const name = decodeURIComponent(mbDel[1]);
      if (user.role !== "admin") {
        const { data: own } = await db().from("mailboxes").select("owner_id").eq("name", name).maybeSingle();
        if (own?.owner_id !== user.id) throw new HttpError(403, "Nur eigene Postfächer.");
      }
      await d.settings.update({ mailboxes: config.mailboxes.filter((x) => x.name !== name) });
      await db().from("mailboxes").delete().eq("name", name);
      json(res, 200, { ok: true });
      return true;
    }
    if (route === "mailboxes/test" && method === "POST") {
      requireAdult(user);
      const b = MailboxBody.partial().parse(await d.readBody(req));
      const saved = config.mailboxes.find((x) => x.name === (b.original_name ?? b.name));
      const password = b.password || saved?.password;
      if (!b.host || !b.port || b.tls === undefined || !b.user || !password) throw new HttpError(400, "Server, Port, Benutzer und Passwort angeben");
      let folders: string[];
      try {
        folders = await imapTest({ host: b.host, port: b.port, tls: b.tls, user: b.user, password });
      } catch (e) {
        throw new HttpError(400, `IMAP-Anmeldung fehlgeschlagen: ${e instanceof Error ? e.message : e}`);
      }
      let smtp = "nicht eingerichtet";
      if (b.smtp_host) {
        try {
          const port = b.smtp_port ?? 587;
          await nodemailer.createTransport({ host: b.smtp_host, port, secure: port === 465, auth: { user: b.user, pass: password } }).verify();
          smtp = "ok";
        } catch (e) {
          smtp = `Fehler: ${e instanceof Error ? e.message : e}`;
        }
      }
      json(res, 200, { ok: true, folders, smtp });
      return true;
    }

    // ── Personen ─────────────────────────────────────────────────────────
    if (route === "users" && method === "GET") {
      requireAdult(user);
      const { data, error } = await db().from("users").select("id, name, role, email, approval_limit_cents, auth_user_id").order("created_at");
      if (error) throw error;
      json(res, 200, (data ?? []).map((u) => ({ ...u, auth_user_id: undefined, has_login: Boolean(u.auth_user_id) })));
      return true;
    }
    const userRoute = route.match(/^users(?:\/([0-9a-f-]{36}))?$/);
    if (userRoute && (method === "POST" || method === "PUT")) {
      requireAdmin(user);
      const b = UserBody.parse(await d.readBody(req));
      const row = {
        name: b.name, role: b.role, email: b.email ? b.email.toLowerCase() : null,
        approval_limit_cents: Math.round((b.approval_limit_euro ?? (b.role === "adult" ? 500 : 0)) * 100),
      };
      if (userRoute[1] === user.id && b.role !== "admin") throw new HttpError(400, "Du kannst dir die Admin-Rolle nicht selbst nehmen.");
      const q = userRoute[1] ? db().from("users").update(row).eq("id", userRoute[1]) : db().from("users").insert(row);
      const { error } = await q;
      if (error) throw new HttpError(400, error.message.includes("users_email_unique") ? "E-Mail ist schon vergeben" : error.message);
      await audit({ agent: "admin", action: "user_saved", level: 1, result: b.name, user_id: user.id });
      json(res, 200, { ok: true });
      return true;
    }
    if (userRoute?.[1] && method === "DELETE") {
      requireAdmin(user);
      if (userRoute[1] === user.id) throw new HttpError(400, "Du kannst dich nicht selbst löschen.");
      const { error } = await db().from("users").delete().eq("id", userRoute[1]);
      if (error) throw new HttpError(409, "Person hat noch Einträge (Aufgaben, Freigaben …) und kann nicht gelöscht werden.");
      json(res, 200, { ok: true });
      return true;
    }

    // ── Konten ───────────────────────────────────────────────────────────
    if (route === "accounts" && method === "GET") {
      requireAdmin(user);
      const { data, error } = await db().from("accounts").select("*").order("label");
      if (error) throw error;
      json(res, 200, data ?? []);
      return true;
    }
    const accRoute = route.match(/^accounts(?:\/([0-9a-f-]{36}))?$/);
    if (accRoute && (method === "POST" || method === "PUT")) {
      requireAdmin(user);
      const b = AccountBody.parse(await d.readBody(req));
      if (!isValidIban(b.iban)) throw new HttpError(400, "IBAN ist ungültig");
      if (b.is_default) await db().from("accounts").update({ is_default: false }).eq("is_default", true);
      const row = { ...b, iban: normalizeIban(b.iban), holder_id: b.holder_id ?? null };
      const q = accRoute[1] ? db().from("accounts").update(row).eq("id", accRoute[1]) : db().from("accounts").insert(row);
      const { error } = await q;
      if (error) throw new HttpError(400, error.message);
      await audit({ agent: "admin", action: "account_saved", level: 1, result: b.label, user_id: user.id });
      json(res, 200, { ok: true });
      return true;
    }
    if (accRoute?.[1] && method === "DELETE") {
      requireAdmin(user);
      const { error } = await db().from("accounts").delete().eq("id", accRoute[1]);
      if (error) throw new HttpError(409, "Konto wird noch verwendet und kann nicht gelöscht werden.");
      json(res, 200, { ok: true });
      return true;
    }

    // ── Zahlungsempfänger ────────────────────────────────────────────────
    if (route === "payees" && method === "GET") {
      requireAdmin(user);
      const { data, error } = await db().from("payees").select("id, name, ibans, default_account_id").order("name");
      if (error) throw error;
      json(res, 200, data ?? []);
      return true;
    }
    if (route === "payees" && method === "POST") {
      requireAdmin(user);
      const b = PayeeBody.parse(await d.readBody(req));
      if (!isValidIban(b.iban)) throw new HttpError(400, "IBAN ist ungültig");
      const iban = normalizeIban(b.iban);
      const { data: existing } = await db().from("payees").select("id, ibans").ilike("name", b.name).maybeSingle();
      const q = existing
        ? db().from("payees").update({ ibans: Array.from(new Set([...(existing.ibans ?? []), iban])), default_account_id: b.default_account_id ?? null }).eq("id", existing.id)
        : db().from("payees").insert({ name: b.name, ibans: [iban], default_account_id: b.default_account_id ?? null });
      const { error } = await q;
      if (error) throw new HttpError(400, error.message);
      json(res, 200, { ok: true });
      return true;
    }
    const payeeDel = route.match(/^payees\/([0-9a-f-]{36})$/);
    if (payeeDel && method === "DELETE") {
      requireAdmin(user);
      const { error } = await db().from("payees").delete().eq("id", payeeDel[1]);
      if (error) throw new HttpError(409, "Empfänger wird noch verwendet.");
      json(res, 200, { ok: true });
      return true;
    }

    // ── Home Assistant ───────────────────────────────────────────────────
    if (route === "ha/entities" && method === "GET") {
      requireAdmin(user);
      const states = await d.ha.states();
      json(res, 200, states
        .map((s) => ({
          entity_id: s.entity_id, domain: s.entity_id.split(".")[0], state: s.state,
          name: String(s.attributes.friendly_name ?? s.entity_id), unit: (s.attributes.unit_of_measurement as string | undefined) ?? null,
        }))
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id)));
      return true;
    }

    throw new HttpError(404, "Nicht gefunden");
  } catch (e) {
    if (e instanceof HttpError) json(res, e.status, { error: e.message });
    else if (e instanceof z.ZodError) json(res, 400, { error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    else throw e;
    return true;
  }
}
