import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claimComment, type ScannedTicket } from "../shared/headless.ts";
export type { ClickupScope } from "../shared/headless.ts";
import type { ShipTicket } from "../shared/ship";
import type { Job, StatusNames } from "./state";

/**
 * Where tickets come from and how the pipeline writes back: a ClickUp list, or a GitHub repo's
 * issues. Both expose the same small surface so the scan loop and the worker do not care which.
 */
export type Source = {
  scan(): Promise<ScannedTicket[]>;
  comments(id: string): Promise<{ text: string; at?: number }[]>;
  claim(id: string, host: string, now: number): Promise<void>;
  setStatus(id: string, which: keyof StatusNames): Promise<void>;
  comment(id: string, text: string): Promise<void>;
  ticket(id: string): Promise<ShipTicket & { body: string; status?: string }>;
};

const run = promisify(execFile);
const gh = async (cwd: string, args: string[]) => (await run("gh", args, { cwd, timeout: 60_000, maxBuffer: 1 << 23 })).stdout;
const CLICKUP = "https://api.clickup.com/api/v2";
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function clickup(key: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${CLICKUP}${path}`, { ...init, headers: { Authorization: key, "Content-Type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickUp ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/** the list's own spelling of a status: exact match on the normalised name, else a few common synonyms */
const SYNONYMS: Record<keyof StatusNames, string[]> = {
  progress: ["in progress", "inprogress", "doing", "in development", "working", "started"],
  review: ["in review", "review", "code review", "pr", "ready for review"],
  done: ["complete", "completed", "done", "closed", "shipped"],
};
export function pickStatus(listStatuses: string[], wanted: string, which: keyof StatusNames): string | undefined {
  const by = new Map(listStatuses.map((s) => [norm(s), s]));
  return by.get(norm(wanted)) ?? SYNONYMS[which].map((s) => by.get(norm(s))).find(Boolean);
}

/** the lists a scope holds: the list itself; a folder's lists; a space's folderless lists plus every folder's lists */
export async function clickupLists(key: string, scope: { kind: "list" | "folder" | "space"; id: string }): Promise<{ id: string; name: string }[]> {
  const row = (l: any) => ({ id: String(l.id), name: String(l.name ?? l.id) });
  if (scope.kind === "list") return [{ id: scope.id, name: scope.id }];
  if (scope.kind === "folder") { const j = await clickup(key, `/folder/${encodeURIComponent(scope.id)}/list?archived=false`); return ((j.lists ?? []) as any[]).map(row); }
  const loose = await clickup(key, `/space/${encodeURIComponent(scope.id)}/list?archived=false`);
  const folders = await clickup(key, `/space/${encodeURIComponent(scope.id)}/folder?archived=false`);
  return [...((loose.lists ?? []) as any[]).map(row), ...((folders.folders ?? []) as any[]).flatMap((f) => ((f.lists ?? []) as any[]).map(row))];
}
export const clickupScopeOf = (job: Job) => job.scope ?? (job.listId ? { kind: "list" as const, id: job.listId } : undefined);

export function clickupSource(key: string, job: Job): Source {
  const scope = clickupScopeOf(job);
  if (!scope) throw new Error(`Job ${job.name} has no ClickUp list, folder or space.`);
  const listStatuses = async (taskId: string) => {
    const t = await clickup(key, `/task/${encodeURIComponent(taskId)}`);
    const list = await clickup(key, `/list/${encodeURIComponent(String(t.list?.id))}`);
    return ((list.statuses ?? []) as any[]).map((s) => String(s.status));
  };
  return {
    async scan() {
      const out: ScannedTicket[] = [];
      const seen = new Set<string>();
      for (const list of await clickupLists(key, scope)) {
        for (let page = 0; page < 10; page++) {
          const j = await clickup(key, `/list/${encodeURIComponent(list.id)}/task?page=${page}&include_closed=false&subtasks=false`);
          const tasks = (j.tasks ?? []) as any[];
          for (const t of tasks) {
            if (seen.has(String(t.id))) continue; // a task shown in several lists counts once
            seen.add(String(t.id));
            out.push({
              id: String(t.id), title: String(t.name ?? t.id), status: t.status?.status, url: t.url ?? `https://app.clickup.com/t/${t.id}`,
              tags: ((t.tags ?? []) as any[]).map((x) => String(x.name)), assignees: ((t.assignees ?? []) as any[]).flatMap((a) => [a.username, a.email].filter(Boolean).map(String)),
              updatedAt: Number(t.date_updated) || undefined,
            });
          }
          if (j.last_page || tasks.length === 0) break;
        }
      }
      return out;
    },
    async comments(id) {
      const j = await clickup(key, `/task/${encodeURIComponent(id)}/comment`);
      return ((j.comments ?? []) as any[]).map((c) => ({ text: String(c.comment_text ?? ""), at: Number(c.date) || undefined }));
    },
    async claim(id, host, now) {
      await clickup(key, `/task/${encodeURIComponent(id)}/comment`, { method: "POST", body: JSON.stringify({ comment_text: claimComment(host, now) }) });
      await this.setStatus(id, "progress");
    },
    async setStatus(id, which) {
      const status = pickStatus(await listStatuses(id), job.statuses[which], which);
      if (!status) throw new Error(`The ClickUp list has no status like "${job.statuses[which]}".`);
      await clickup(key, `/task/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ status }) });
    },
    async comment(id, text) {
      await clickup(key, `/task/${encodeURIComponent(id)}/comment`, { method: "POST", body: JSON.stringify({ comment_text: text }) });
    },
    async ticket(id) {
      const t = await clickup(key, `/task/${encodeURIComponent(id)}?include_markdown_description=true`);
      return { source: "clickup", id: String(t.id), url: t.url ?? `https://app.clickup.com/t/${t.id}`, title: t.name ?? String(t.id), body: t.markdown_description ?? t.description ?? "", status: t.status?.status };
    },
  };
}

export function githubSource(job: Job): Source {
  const label = (which: keyof StatusNames) => `consort:${job.statuses[which].toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const ensureLabel = (name: string) => gh(job.repo, ["label", "create", name, "--color", "5319e7", "--description", "set by consort-cli", "--force"]).catch(() => "");
  return {
    async scan() {
      const j = JSON.parse(await gh(job.repo, ["issue", "list", "--state", "open", "--limit", "100", "--json", "number,title,labels,assignees,url,updatedAt,state"])) as any[];
      return j.map((i) => ({
        id: String(i.number), title: String(i.title), status: String(i.state ?? "open").toLowerCase(), url: i.url,
        tags: ((i.labels ?? []) as any[]).map((l) => String(l.name)), assignees: ((i.assignees ?? []) as any[]).map((a) => String(a.login)),
        updatedAt: Date.parse(i.updatedAt) || undefined,
      }));
    },
    async comments(id) {
      const j = JSON.parse(await gh(job.repo, ["issue", "view", id, "--json", "comments"]));
      return ((j.comments ?? []) as any[]).map((c) => ({ text: String(c.body ?? ""), at: Date.parse(c.createdAt) || undefined }));
    },
    async claim(id, host, now) {
      await gh(job.repo, ["issue", "comment", id, "--body", claimComment(host, now)]);
      await this.setStatus(id, "progress");
    },
    async setStatus(id, which) {
      const want = label(which);
      await ensureLabel(want);
      const others = (["progress", "review", "done"] as const).filter((k) => k !== which).map(label);
      await gh(job.repo, ["issue", "edit", id, "--add-label", want, ...others.flatMap((l) => ["--remove-label", l])]).catch(async () => { await gh(job.repo, ["issue", "edit", id, "--add-label", want]); });
    },
    async comment(id, text) { await gh(job.repo, ["issue", "comment", id, "--body", text]); },
    async ticket(id) {
      const j = JSON.parse(await gh(job.repo, ["issue", "view", id, "--json", "number,title,url,body,state"]));
      const repo = /github\.com\/([^/]+\/[^/]+)\//.exec(j.url ?? "")?.[1];
      return { source: "github", id: String(j.number), url: j.url, title: j.title ?? `#${id}`, repo, body: j.body ?? "", status: String(j.state ?? "").toLowerCase() };
    },
  };
}

export const sourceFor = (job: Job, clickupKey?: string): Source => {
  if (job.source === "clickup") { if (!clickupKey) throw new Error("No ClickUp API key: run `consort-cli clickup set-key <key>`."); return clickupSource(clickupKey, job); }
  return githubSource(job);
};
