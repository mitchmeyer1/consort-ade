import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { classifyLink, dossierFile, dossierMarkdown, extractLinks, type Dossier, type LinkedItem } from "../shared/investigate";
import type { ShipTicket } from "../shared/ship";

/**
 * Builds the dossier an investigation chat reads (shared/investigate.ts): the ticket from its
 * tracker, its comments, and one hop of what it links to. Everything Consort cannot reach is
 * recorded as unreadable rather than dropped, so the chat knows what to ask the user for.
 */

const run = promisify(execFile);
const gh = async (cwd: string, args: string[]) => (await run("gh", args, { cwd, timeout: 60_000, maxBuffer: 1 << 22 })).stdout;
const CLICKUP = "https://api.clickup.com/api/v2";
const MAX_LINKED = 12;

export type Deps = { repoPath: string; clickupKey?: string };

async function clickup(key: string, path: string) {
  const res = await fetch(`${CLICKUP}${path}`, { headers: { Authorization: key, "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickUp ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

const clickupUrl = (id: string) => `https://app.clickup.com/t/${id}`;
const when = (ms: unknown) => { const n = Number(ms); return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : ""; };

/** a ClickUp task with its comments, subtasks and linked tasks */
async function clickupDossier(id: string, key: string): Promise<Omit<Dossier, "fetchedAt" | "unreadable">> {
  const t = await clickup(key, `/task/${encodeURIComponent(id)}?include_subtasks=true&include_markdown_description=true`);
  const ticket: ShipTicket = { source: "clickup", id: String(t.id), url: t.url ?? clickupUrl(String(t.id)), title: t.name ?? String(t.id) };
  const comments = await clickup(key, `/task/${encodeURIComponent(id)}/comment`).then((c) => (c.comments ?? []) as any[], () => [] as any[]);
  const linked: LinkedItem[] = [];
  for (const s of (t.subtasks ?? []) as any[]) if (linked.length < MAX_LINKED) linked.push({ kind: "clickup subtask", ref: String(s.id), url: clickupUrl(String(s.id)), title: s.name, status: s.status?.status });
  const linkIds = [...new Set(((t.linked_tasks ?? []) as any[]).map((l) => String(l.task_id === t.id ? l.link_id : l.task_id)).filter((x) => x && x !== String(t.id)))];
  for (const lid of linkIds.slice(0, MAX_LINKED - linked.length)) {
    const item = await clickup(key, `/task/${encodeURIComponent(lid)}`).catch(() => undefined);
    if (item) linked.push({ kind: "clickup task", ref: String(item.id), url: item.url ?? clickupUrl(lid), title: item.name, status: item.status?.status, excerpt: trim(item.description) });
  }
  return {
    ticket, body: t.markdown_description ?? t.description ?? "", status: t.status?.status,
    assignees: ((t.assignees ?? []) as any[]).map((a) => a.username ?? a.email ?? "").filter(Boolean),
    comments: comments.map((c) => ({ author: c.user?.username ?? "", at: when(c.date), text: c.comment_text ?? "" })),
    linked,
  };
}

/** a GitHub issue with its comments */
async function githubDossier(number: number, repoPath: string): Promise<Omit<Dossier, "fetchedAt" | "unreadable">> {
  const j = JSON.parse(await gh(repoPath, ["issue", "view", String(number), "--json", "number,title,url,body,state,assignees,comments"]));
  const repo = /github\.com\/([^/]+\/[^/]+)\//.exec(j.url ?? "")?.[1];
  return {
    ticket: { source: "github", id: String(j.number), url: j.url, title: j.title ?? `#${number}`, repo },
    body: j.body ?? "", status: j.state ? String(j.state).toLowerCase() : undefined,
    assignees: ((j.assignees ?? []) as any[]).map((a) => a.login).filter(Boolean),
    comments: ((j.comments ?? []) as any[]).map((c) => ({ author: c.author?.login ?? "", at: c.createdAt ?? "", text: c.body ?? "" })),
    linked: [],
  };
}

const trim = (s: unknown, max = 600) => { const t = typeof s === "string" ? s.trim() : ""; return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : undefined; };

/** one hop along the links in the ticket and its comments: tasks, issues and PRs Consort can read; the rest is for the user */
async function followLinks(d: Omit<Dossier, "fetchedAt" | "unreadable">, deps: Deps): Promise<{ linked: LinkedItem[]; unreadable: string[] }> {
  const seen = new Set<string>([d.ticket.url, ...d.linked.map((l) => l.url)]);
  const linked = [...d.linked];
  const unreadable: string[] = [];
  for (const url of extractLinks([d.body, ...d.comments.map((c) => c.text)].join("\n"))) {
    if (seen.has(url)) continue;
    seen.add(url);
    const link = classifyLink(url);
    if (link.kind === "other") { unreadable.push(url); continue; }
    if (linked.length >= MAX_LINKED) continue;
    try {
      if (link.kind === "clickup") {
        if (!deps.clickupKey) { unreadable.push(url); continue; }
        if (linked.some((l) => l.ref === link.id)) continue;
        const item = await clickup(deps.clickupKey, `/task/${encodeURIComponent(link.id)}`);
        linked.push({ kind: "clickup task", ref: String(item.id), url, title: item.name, status: item.status?.status, excerpt: trim(item.description) });
      } else {
        const repoArgs = link.repo ? ["--repo", link.repo] : [];
        if (link.kind === "github-pr") {
          const pr = JSON.parse(await gh(deps.repoPath, ["pr", "view", String(link.number), ...repoArgs, "--json", "number,title,state,body,url"]));
          linked.push({ kind: "github pr", ref: `#${pr.number}`, url, title: pr.title, status: String(pr.state ?? "").toLowerCase(), excerpt: trim(pr.body) });
        } else {
          const issue = JSON.parse(await gh(deps.repoPath, ["issue", "view", String(link.number), ...repoArgs, "--json", "number,title,state,body,url"]));
          linked.push({ kind: "github issue", ref: `#${issue.number}`, url, title: issue.title, status: String(issue.state ?? "").toLowerCase(), excerpt: trim(issue.body) });
        }
      }
    } catch { unreadable.push(url); }
  }
  return { linked, unreadable };
}

export async function buildDossier(from: { source: "github"; number: number } | { source: "clickup"; id: string }, deps: Deps): Promise<Dossier> {
  if (from.source === "clickup" && !deps.clickupKey) throw new Error("Add a ClickUp API key in Settings › Ship first.");
  const base = from.source === "clickup" ? await clickupDossier(from.id, deps.clickupKey!) : await githubDossier(from.number, deps.repoPath);
  const { linked, unreadable } = await followLinks(base, deps);
  return { ...base, linked, unreadable, fetchedAt: Date.now() };
}

/** write the dossier into the checkout the chat runs in; resolves to the file's absolute path */
export function writeDossier(worktreePath: string, d: Dossier): string {
  const file = join(worktreePath, dossierFile(d.ticket));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, dossierMarkdown(d));
  writeFileSync(join(dirname(file), "dossier.json"), `${JSON.stringify(d, null, 2)}\n`);
  return file;
}
