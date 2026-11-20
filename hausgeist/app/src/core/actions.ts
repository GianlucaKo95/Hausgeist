import { db, audit, listUsers } from "./db.js";
import { canApproveAction, formatEuro, type ActionKind, type AppUser } from "./checks.js";
import type { Config } from "./config.js";
import type { HomeAssistant } from "../adapters/homeassistant.js";
import type { AppleCalendar } from "../adapters/calendar.js";
import { sendMail } from "../adapters/mail.js";
import { logger } from "./log.js";

const log = logger("actions");

export const ACTION_OK = "HG_ACT_OK:";
export const ACTION_NO = "HG_ACT_NO:";

export interface SendMailPayload {
  mailbox: string;
  to: string;
  cc?: string | null;
  subject: string;
  body: string;
  inReplyTo?: string | null;
}
export interface OrderPayload {
  shop: string;
  items: { name: string; quantity: number; price_cents: number; url?: string | null }[];
  total_cents: number;
  note?: string | null;
}
export interface HaServicePayload {
  domain: string;
  service: string;
  entity_id: string;
  data?: Record<string, unknown>;
}
export interface CalendarPayload {
  calendar: string;
  title: string;
  start: string;
  end: string;
  location?: string | null;
  notes?: string | null;
}

type Payloads = {
  send_mail: SendMailPayload;
  order: OrderPayload;
  ha_service: HaServicePayload;
  calendar_event: CalendarPayload;
};

/**
 * Stufe-2-Aktionen: Agenten dürfen sie nur beantragen. Ausgeführt wird erst
 * nach Freigabe, mit genau dem eingefrorenen Payload, durch festen Code.
 */
export class ActionService {
  constructor(
    private readonly config: Config,
    private readonly ha: HomeAssistant,
    private readonly calendar: AppleCalendar,
  ) {}

  private async mailboxOwner(name: string): Promise<string | null> {
    const { data } = await db().from("mailboxes").select("owner_id").eq("name", name).maybeSingle();
    return data?.owner_id ?? null;
  }

  async request<K extends ActionKind>(
    kind: K,
    payload: Payloads[K],
    meta: { agent: string; summary: string; requestedBy: AppUser | null },
  ): Promise<{ id: string; approvers: string[] }> {
    const amount = kind === "order" ? (payload as OrderPayload).total_cents : null;
    const { data, error } = await db()
      .from("actions")
      .insert({ kind, agent: meta.agent, summary: meta.summary, payload, amount_cents: amount, requested_by: meta.requestedBy?.id ?? null })
      .select("id")
      .single();
    if (error) throw error;

    const owner = kind === "send_mail" ? await this.mailboxOwner((payload as SendMailPayload).mailbox) : null;
    const users = await listUsers();
    const approvers = users.filter(
      (u) => u.notify_service && canApproveAction(u, { kind, amount_cents: amount, mailbox_owner_id: owner }).allowed,
    );
    const title = { send_mail: "Mail senden?", order: "Bestellen?", ha_service: "Gerät schalten?", calendar_event: "Termin eintragen?" }[kind];
    const requester = meta.requestedBy ? `\nAngefragt von ${meta.requestedBy.name}` : "";
    for (const u of approvers) {
      await this.ha.notify(u.notify_service!, title, `${meta.summary}${requester}`, [
        { action: `${ACTION_OK}${data.id}`, title: "Freigeben" },
        { action: `${ACTION_NO}${data.id}`, title: "Ablehnen", destructive: true },
      ], `hg-act-${data.id}`);
    }
    await audit({ agent: meta.agent, action: `request_${kind}`, level: 2, result: "pending", user_id: meta.requestedBy?.id, ref_table: "actions", ref_id: data.id });
    return { id: data.id, approvers: approvers.map((u) => u.name) };
  }

  async handleDecision(action: string, haUserId: string | null): Promise<boolean> {
    const ok = action.startsWith(ACTION_OK);
    if (!ok && !action.startsWith(ACTION_NO)) return false;
    const id = action.slice((ok ? ACTION_OK : ACTION_NO).length);

    const users = await listUsers();
    const user = users.find((u) => u.ha_user_id && u.ha_user_id === haUserId);
    if (!user) {
      await audit({ agent: "actions", action: "decision", level: 2, result: "unknown_user", detail: { haUserId, id } });
      return true;
    }
    const r = await this.decide(user, id, ok);
    if (!r.ok && user.notify_service) await this.ha.notify(user.notify_service, "Freigabe nicht möglich", r.message);
    return true;
  }

  /** Darf diese Person über die Aktion entscheiden? (für die Freigabeliste der App) */
  async canDecide(user: AppUser, act: { kind: ActionKind; amount_cents: number | null; payload: Record<string, unknown> }): Promise<boolean> {
    const owner = act.kind === "send_mail" ? await this.mailboxOwner(String(act.payload.mailbox)) : null;
    return canApproveAction(user, { kind: act.kind, amount_cents: act.amount_cents, mailbox_owner_id: owner }).allowed;
  }

  /** Entscheidung über eine Aktion – aus der HA-Benachrichtigung oder der App. */
  async decide(user: AppUser, id: string, ok: boolean): Promise<{ ok: boolean; message: string }> {
    const { data: act } = await db().from("actions").select("*").eq("id", id).maybeSingle();
    if (!act || act.status !== "pending") return { ok: false, message: "Diese Anfrage ist bereits entschieden." };
    if (!(await this.canDecide(user, act))) {
      // Auch Ablehnen nur durch Berechtigte, sonst könnte jeder Anfragen anderer verwerfen.
      return { ok: false, message: "Du darfst über diese Anfrage nicht entscheiden." };
    }
    const { data: updated } = await db()
      .from("actions")
      .update({ status: ok ? "approved" : "rejected", decided_by: user.id, decided_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "pending")
      .select("*");
    if (!updated?.length) return { ok: false, message: "Diese Anfrage ist bereits entschieden." };
    await audit({ agent: "actions", action: "decision", level: 2, result: ok ? "approved" : "rejected", user_id: user.id, ref_table: "actions", ref_id: id });
    if (!ok) return { ok: true, message: "Abgelehnt" };
    const result = await this.execute(id, user);
    return { ok: true, message: result };
  }

  private async execute(id: string, decider: AppUser): Promise<string> {
    const { data: act } = await db().from("actions").select("*").eq("id", id).single();
    if (!act || act.status !== "approved") return "Nicht freigegeben";
    let result: string;
    try {
      result = await this.run(act.kind as ActionKind, act.payload);
      await db().from("actions").update({ status: "done", result }).eq("id", id);
      await audit({ agent: "executor", action: act.kind, level: 2, result: "done", user_id: decider.id, ref_table: "actions", ref_id: id });
    } catch (e) {
      result = `Fehler: ${e instanceof Error ? e.message : String(e)}`;
      await db().from("actions").update({ status: "failed", result }).eq("id", id);
      await audit({ agent: "executor", action: act.kind, level: 2, result: "failed", user_id: decider.id, ref_table: "actions", ref_id: id, detail: { error: result } });
      log.error(`Aktion ${id} fehlgeschlagen`, e);
    }
    if (decider.notify_service) await this.ha.notify(decider.notify_service, "Hausgeist", result);
    return result;
  }

  private async run(kind: ActionKind, payload: Record<string, unknown>): Promise<string> {
    switch (kind) {
      case "send_mail": {
        const p = payload as unknown as SendMailPayload;
        const mb = this.config.mailboxes.find((m) => m.name === p.mailbox);
        if (!mb) throw new Error(`Postfach ${p.mailbox} nicht konfiguriert`);
        await sendMail(mb, p);
        return `Mail an ${p.to} gesendet: ${p.subject}`;
      }
      case "order": {
        // Es gibt keine allgemeine Shop-Schnittstelle: Der Warenkorb wird mit
        // Links zugestellt und als bestellt markiert, sobald er freigegeben ist.
        const p = payload as unknown as OrderPayload;
        await db().from("orders").insert({ shop: p.shop, items: p.items, total_cents: p.total_cents, status: "ordered" });
        const links = p.items.map((i) => `${i.quantity}× ${i.name}${i.url ? `: ${i.url}` : ""}`).join("\n");
        return `Bestellung bei ${p.shop} freigegeben (${formatEuro(p.total_cents)}). Bitte im Shop abschließen:\n${links}`;
      }
      case "ha_service": {
        const p = payload as unknown as HaServicePayload;
        await this.ha.callService(p.domain, p.service, { entity_id: p.entity_id, ...(p.data ?? {}) });
        return `${p.domain}.${p.service} für ${p.entity_id} ausgeführt`;
      }
      case "calendar_event": {
        const p = payload as unknown as CalendarPayload;
        await this.calendar.createEvent(p.calendar, p);
        return `Termin „${p.title}“ in ${p.calendar} eingetragen`;
      }
    }
  }
}
