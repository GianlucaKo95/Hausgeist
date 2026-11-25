import { randomUUID } from "node:crypto";

export interface ChatJob {
  id: string;
  userId: string;
  status: "running" | "done" | "error";
  reply?: string;
  error?: string;
  created: number;
  delivered: boolean;
  notified: boolean;
  /** Bisher gestreamter Antworttext (Sprachchat liest ab dem ersten Satz vor). */
  text: string;
}

export type JobEvent = { t: "text"; d: string } | { t: "done"; reply: string } | { t: "error"; error: string };

/**
 * Chat-Anfragen laufen auf dem Pi zu Ende, auch wenn die App in den Hintergrund
 * geht oder die Verbindung abreißt. Holt niemand die Antwort ab, kommt sie per Push;
 * beim nächsten Öffnen holt die App sie trotzdem in den Verlauf.
 */
export class ChatJobs {
  private jobs = new Map<string, ChatJob>();
  private waiters = new Map<string, Set<(j: ChatJob) => void>>();
  private streams = new Map<string, Set<(e: JobEvent) => void>>();

  constructor(
    private readonly onUndelivered: (job: ChatJob) => Promise<void>,
    private readonly graceMs = 4000,
  ) {}

  start(userId: string, work: Promise<string>): ChatJob {
    this.cleanup();
    const job: ChatJob = { id: randomUUID(), userId, status: "running", created: Date.now(), delivered: false, notified: false, text: "" };
    this.jobs.set(job.id, job);
    work.then(
      (reply) => { job.status = "done"; job.reply = reply; },
      (e) => { job.status = "error"; job.error = e instanceof Error ? e.message : String(e); },
    ).finally(() => {
      const st = this.streams.get(job.id);
      this.streams.delete(job.id);
      if (st?.size) {
        job.delivered = true;
        const ev: JobEvent = job.status === "done" ? { t: "done", reply: job.reply ?? "" } : { t: "error", error: job.error ?? "Fehler" };
        for (const fn of st) fn(ev);
      }
      const w = this.waiters.get(job.id);
      this.waiters.delete(job.id);
      if (w?.size) {
        job.delivered = true;
        for (const fn of w) fn(job);
        return;
      }
      // Niemand wartet gerade (App im Hintergrund) – kurz warten, dann Push.
      setTimeout(() => {
        if (job.delivered || job.notified) return;
        job.notified = true;
        this.onUndelivered(job).catch(() => undefined);
      }, this.graceMs);
    });
    return job;
  }

  /** Neuer Antworttext-Schnipsel (nur von der obersten Ebene, nicht aus Fach-Agenten). */
  pushText(id: string, delta: string): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return;
    job.text += delta;
    for (const fn of this.streams.get(id) ?? []) fn({ t: "text", d: delta });
  }

  /** Ereignisse eines Auftrags abonnieren; bereits vorhandener Text kommt sofort. */
  subscribe(id: string, userId: string, fn: (e: JobEvent) => void): (() => void) | undefined {
    const job = this.get(id, userId);
    if (!job) return undefined;
    if (job.text) fn({ t: "text", d: job.text });
    if (job.status !== "running") {
      job.delivered = true;
      fn(job.status === "done" ? { t: "done", reply: job.reply ?? "" } : { t: "error", error: job.error ?? "Fehler" });
      return () => undefined;
    }
    const set = this.streams.get(id) ?? new Set();
    set.add(fn);
    this.streams.set(id, set);
    return () => set.delete(fn);
  }

  get(id: string, userId: string): ChatJob | undefined {
    const j = this.jobs.get(id);
    return j && j.userId === userId ? j : undefined;
  }

  /** Wartet bis zu ms auf das Ergebnis (Long-Polling). */
  async wait(id: string, userId: string, ms: number): Promise<ChatJob | undefined> {
    const job = this.get(id, userId);
    if (!job) return undefined;
    if (job.status !== "running") { job.delivered = true; return job; }
    if (ms <= 0) return job;
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      const done = (j: ChatJob) => { clearTimeout(timer); resolve(j); };
      const timer = setTimeout(() => { set.delete(done); resolve(job); }, ms);
      set.add(done);
      this.waiters.set(id, set);
    });
  }

  /** Noch nicht abgeholte Antworten und laufende Anfragen einer Person. */
  open(userId: string): ChatJob[] {
    return [...this.jobs.values()].filter((j) => j.userId === userId && (j.status === "running" || !j.delivered));
  }

  private cleanup(): void {
    const cutoff = Date.now() - 24 * 3600_000;
    for (const [id, j] of this.jobs) if (j.created < cutoff) this.jobs.delete(id);
  }
}
