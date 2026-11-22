import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Config, MailboxConfig } from "../core/config.js";
import { logger } from "../core/log.js";

const log = logger("communication");

export interface IncomingPdf {
  filename: string;
  content: Buffer;
}

export interface IncomingMail {
  mailbox: string;
  messageId: string | null;
  from: string;
  subject: string;
  date: Date | null;
  text: string;
  pdfs: IncomingPdf[];
  /** Kalendereinladungen (.ics) */
  invites: IncomingPdf[];
}

type State = Record<string, { uidValidity: string; lastUid: number }>;

/**
 * Communication-Agent, Phase 1: überwacht IMAP-Postfächer per IDLE und meldet
 * neue Mails mit PDF-Anhang oder Kalendereinladung. Er liest nur – Antworten und Senden kommen später
 * und laufen dann über eine Freigabe (Stufe 2).
 */
export class CommunicationAgent {
  private readonly statePath: string;

  constructor(
    private readonly config: Config,
    private readonly onMail: (mail: IncomingMail) => Promise<void>,
  ) {
    this.statePath = join(config.dataDir, "imap-state.json");
  }

  start(): void {
    if (this.config.mailboxes.length === 0) log.warn("Keine Postfächer konfiguriert");
    for (const mb of this.config.mailboxes) void this.watch(mb, 1000);
  }

  private readState(): State {
    return existsSync(this.statePath) ? JSON.parse(readFileSync(this.statePath, "utf8")) : {};
  }

  private writeState(state: State): void {
    writeFileSync(this.statePath, JSON.stringify(state, null, 2));
  }

  private async watch(mb: MailboxConfig, retryMs: number): Promise<void> {
    const client = new ImapFlow({
      host: mb.host,
      port: mb.port,
      secure: mb.tls,
      auth: { user: mb.user, pass: mb.password },
      logger: false,
    });
    const folder = mb.folder || "INBOX";
    let busy = false;
    let pending = false;

    const poll = async () => {
      if (busy) {
        pending = true;
        return;
      }
      busy = true;
      try {
        do {
          pending = false;
          await this.fetchNew(client, mb);
        } while (pending);
      } catch (e) {
        log.error(`${mb.name}: Abruf fehlgeschlagen`, e);
      } finally {
        busy = false;
      }
    };

    client.on("exists", () => void poll());
    client.on("close", () => {
      const next = Math.min(retryMs * 2, 300_000);
      log.warn(`${mb.name}: Verbindung beendet, neuer Versuch in ${next / 1000}s`);
      setTimeout(() => void this.watch(mb, next), next);
    });
    client.on("error", (e: Error) => log.warn(`${mb.name}: IMAP-Fehler`, e));

    try {
      await client.connect();
      await client.mailboxOpen(folder);
      log.info(`${mb.name}: überwache ${folder}`);
      await poll();
    } catch (e) {
      log.error(`${mb.name}: Verbindung fehlgeschlagen`, e);
      // "close" plant den nächsten Versuch
    }
  }

  private async fetchNew(client: ImapFlow, mb: MailboxConfig): Promise<void> {
    const box = client.mailbox;
    if (!box) return;
    const state = this.readState();
    const validity = String(box.uidValidity);
    const entry = state[mb.name];

    // Erster Start oder Postfach neu aufgebaut: alte Mails nicht nachverarbeiten.
    if (!entry || entry.uidValidity !== validity) {
      state[mb.name] = { uidValidity: validity, lastUid: Number(box.uidNext) - 1 };
      this.writeState(state);
      log.info(`${mb.name}: Startpunkt gesetzt, bestehende Mails werden übersprungen`);
      return;
    }

    let lastUid = entry.lastUid;
    for await (const msg of client.fetch({ uid: `${lastUid + 1}:*` }, { uid: true, source: true }, { uid: true })) {
      if (msg.uid <= lastUid || !msg.source) continue;
      try {
        const parsed = await simpleParser(msg.source);
        const pdfs = parsed.attachments
          .filter((a) => a.contentType === "application/pdf" || a.filename?.toLowerCase().endsWith(".pdf"))
          .map((a) => ({ filename: a.filename ?? "dokument.pdf", content: a.content }));
        const invites = parsed.attachments
          .filter((a) => a.contentType === "text/calendar" || a.filename?.toLowerCase().endsWith(".ics"))
          .map((a) => ({ filename: a.filename ?? "einladung.ics", content: a.content }));
        if (pdfs.length > 0 || invites.length > 0) {
          await this.onMail({
            mailbox: mb.name,
            messageId: parsed.messageId ?? null,
            from: parsed.from?.text ?? "",
            subject: parsed.subject ?? "",
            date: parsed.date ?? null,
            text: (parsed.text ?? "").slice(0, 4000),
            pdfs,
            invites,
          });
        }
      } catch (e) {
        log.error(`${mb.name}: Mail ${msg.uid} konnte nicht verarbeitet werden`, e);
      }
      lastUid = msg.uid;
      state[mb.name] = { uidValidity: validity, lastUid };
      this.writeState(state);
    }
  }
}
