import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ok, safe, requireAdult, type ToolContext } from "./context.js";

/** GitHub-Werkzeuge des Business-Agenten (eigene Projekte wie Meeterz und Polaris). */
export function githubTools(ctx: ToolContext) {
  const gh = async <T>(path: string, init?: RequestInit): Promise<T> => {
    if (!ctx.config.github_token) throw new Error("github_token ist nicht konfiguriert");
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${ctx.config.github_token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (!res.ok) throw new Error(`GitHub ${path}: ${res.status}`);
    return res.json() as Promise<T>;
  };

  return [
    tool("list_repos", "Eigene GitHub-Repositories, zuletzt aktive zuerst.", {}, safe(async () => {
      requireAdult(ctx);
      const r = await gh<{ full_name: string; pushed_at: string; open_issues_count: number }[]>("/user/repos?sort=pushed&per_page=30");
      return ok(r.map((x) => ({ repo: x.full_name, pushed_at: x.pushed_at, open_issues: x.open_issues_count })));
    })),

    tool("list_issues", "Offene Issues eines Repositories.", { repo: z.string().describe("owner/name") }, safe(async (a) => {
      requireAdult(ctx);
      const r = await gh<{ number: number; title: string; labels: { name: string }[]; updated_at: string; pull_request?: unknown }[]>(`/repos/${a.repo}/issues?state=open&per_page=50`);
      return ok(r.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, labels: i.labels.map((l) => l.name), updated_at: i.updated_at })));
    })),

    tool("create_issue", "Issue in einem eigenen Repository anlegen (Stufe 1, nur interne Projektverwaltung).", {
      repo: z.string(), title: z.string(), body: z.string().optional(), labels: z.array(z.string()).optional(),
    }, safe(async (a) => {
      requireAdult(ctx);
      const r = await gh<{ html_url: string }>(`/repos/${a.repo}/issues`, { method: "POST", body: JSON.stringify({ title: a.title, body: a.body, labels: a.labels }) });
      return ok(r.html_url);
    })),
  ];
}
