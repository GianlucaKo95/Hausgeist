import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import type { MailboxConfig } from "../core/config.js";

export interface MailSummary {
  uid: number;
  from: string;
  subject: string;
  date: string | null;
  seen: boolean;
}

async function withImap<T>(mb: MailboxConfig, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: mb.host, port: mb.port, secure: mb.tls,
    auth: { user: mb.user, pass: mb.password }, logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock(mb.folder || "INBOX");
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export async function listMails(mb: MailboxConfig, opts: { days: number; unseenOnly: boolean; limit: number; query?: string }): Promise<MailSummary[]> {
  return withImap(mb, async (c) => {
    const since = new Date(Date.now() - opts.days * 86_400_000);
    const criteria: Record<string, unknown> = { since };
    if (opts.unseenOnly) criteria.seen = false;
    if (opts.query) criteria.or = [{ subject: opts.query }, { from: opts.query }, { body: opts.query }];
    const uids = (await c.search(criteria, { uid: true })) || [];
    const pick = uids.slice(-opts.limit);
    const out: MailSummary[] = [];
    if (pick.length === 0) return out;
    for await (const m of c.fetch(pick, { uid: true, envelope: true, flags: true }, { uid: true })) {
      out.push({
        uid: m.uid,
        from: m.envelope?.from?.map((a) => `${a.name ?? ""} <${a.address ?? ""}>`.trim()).join(", ") ?? "",
        subject: m.envelope?.subject ?? "",
        date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : null,
        seen: m.flags?.has("\\Seen") ?? false,
      });
    }
    return out.reverse();
  });
}

export async function readMail(mb: MailboxConfig, uid: number) {
  return withImap(mb, async (c) => {
    const msg = await c.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) throw new Error(`Mail ${uid} nicht gefunden`);
    const p = await simpleParser(msg.source);
    return {
      uid,
      messageId: p.messageId ?? null,
      from: p.from?.text ?? "",
      replyTo: p.replyTo?.text ?? p.from?.text ?? "",
      to: Array.isArray(p.to) ? p.to.map((t) => t.text).join(", ") : p.to?.text ?? "",
      subject: p.subject ?? "",
      date: p.date?.toISOString() ?? null,
      text: (p.text ?? "").slice(0, 12_000),
      attachments: p.attachments.map((a) => a.filename ?? a.contentType),
    };
  });
}

export async function moveMail(mb: MailboxConfig, uid: number, folder: string): Promise<void> {
  await withImap(mb, async (c) => {
    await c.mailboxCreate(folder).catch(() => undefined);
    await c.messageMove(String(uid), folder, { uid: true });
  });
}

export async function flagMail(mb: MailboxConfig, uid: number, flag: "seen" | "flagged"): Promise<void> {
  await withImap(mb, async (c) => {
    await c.messageFlagsAdd(String(uid), [flag === "seen" ? "\\Seen" : "\\Flagged"], { uid: true });
  });
}

export async function sendMail(
  mb: MailboxConfig,
  mail: { to: string; cc?: string | null; subject: string; body: string; inReplyTo?: string | null },
): Promise<string> {
  if (!mb.smtp_host) throw new Error(`Für Postfach ${mb.name} ist kein smtp_host konfiguriert`);
  const transport = nodemailer.createTransport({
    host: mb.smtp_host,
    port: mb.smtp_port ?? 587,
    secure: (mb.smtp_port ?? 587) === 465,
    auth: { user: mb.user, pass: mb.password },
  });
  const info = await transport.sendMail({
    from: mb.from_name ? `"${mb.from_name}" <${mb.user}>` : mb.user,
    to: mail.to,
    cc: mail.cc ?? undefined,
    subject: mail.subject,
    text: mail.body,
    ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo, references: mail.inReplyTo } : {}),
  });
  return info.messageId;
}
