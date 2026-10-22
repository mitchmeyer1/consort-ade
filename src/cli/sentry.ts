/** Sentry is a ticket producer: it never claims work or starts a worker agent. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { groupSentryIssues, matchingSentryTask, sentryReservationKey, sentryIssueReservationKey, sentryTicketDescription, type SentryGroup, type SentryIssue, type SentryScannerConfig } from "../shared/sentryScanner.ts";
import type { Job } from "./state";
const run = promisify(execFile);
const CLICKUP = "https://api.clickup.com/api/v2";
export type SentryScanResult = { issues: number; groups: number; created: number; existing: number; reserved: number; preview: number; tickets: string[] };
type Deps = { fetch: typeof fetch; reserve: (job: Job, key: string) => Promise<boolean>; plan: (job: Job, groups: SentryGroup[]) => Promise<SentryGroup[]> };

/** Atomic GitHub ref creation elects one producer across processes/machines. Never auto-delete a reservation. */
export async function reserveSentryGroup(job: Job, key: string, execute?: (args: string[]) => Promise<string>): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid Sentry reservation key.");
  const gh = execute ?? (async (args: string[]) => (await run("gh", args, { cwd: job.repo, timeout: 60_000, maxBuffer: 1 << 20 })).stdout);
  const name = (await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"])).trim();
  const ref = `heads/consort-sentry/${key}`;
  const base = JSON.parse(await gh(["api", `repos/${name}/git/ref/heads/${encodeURIComponent(job.base)}`]));
  if (!base.object?.sha) throw new Error("Cannot reserve Sentry group: GitHub base commit is unavailable.");
  try {
    await gh(["api", "--method", "POST", `repos/${name}/git/refs`, "-f", `ref=refs/${ref}`, "-f", `sha=${base.object.sha}`]);
    return true;
  } catch {
    // A timeout may have committed the reservation. Refusing to create in that case prevents a second ticket.
    const existing = await gh(["api", `repos/${name}/git/ref/${ref}`]).then((s) => JSON.parse(s), () => undefined);
    if (existing?.ref === `refs/${ref}`) return false;
    throw new Error("Sentry group reservation failed; no ClickUp ticket was created. Check GitHub access.");
  }
}

export function validateSentryConfig(config: SentryScannerConfig | undefined): asserts config is SentryScannerConfig {
  if (!config?.org || !config.token || !config.projects?.length || !config.workspaceId || !config.listId || !config.tag.trim()) throw new Error("Sentry scanner needs an organization, projects, token, ClickUp workspace/list and output tag.");
  const url = new URL(config.host);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Sentry host must be an HTTPS origin without credentials or a path.");
  if (!/^[a-z0-9_-]+$/i.test(config.org) || config.projects.some((p) => !/^[a-z0-9_-]+$/i.test(p))) throw new Error("Invalid Sentry organization/project slug.");
}
async function jsonRequest(fetcher: typeof fetch, url: string, token: string, init: RequestInit = {}): Promise<{ data: any; response: Response }> {
  const response = await fetcher(url, { ...init, headers: { Authorization: token, "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${response.status}; scan stopped without retrying task creation.`);
  return { data: await response.json(), response };
}

export async function readSentryIssues(config: SentryScannerConfig, fetcher: typeof fetch = fetch): Promise<SentryIssue[]> {
  validateSentryConfig(config);
  const params = new URLSearchParams({ query: config.query || "is:unresolved", sort: "date", limit: "100" });
  for (const p of config.projects) params.append("project", p);
  for (const env of config.environments) params.append("environment", env);
  const endpoint = `${config.host.replace(/\/$/, "")}/api/0/organizations/${encodeURIComponent(config.org)}/issues/`;
  const issues: SentryIssue[] = [];
  const cursors = new Set<string>();
  for (;;) {
    const { data, response } = await jsonRequest(fetcher, `${endpoint}?${params}`, `Bearer ${config.token}`);
    if (!Array.isArray(data)) throw new Error("Sentry returned an invalid issues response.");
    issues.push(...data);
    const next = (response.headers.get("link") ?? "").split(/,(?=\s*<)/).find((s) => /rel="next"/.test(s) && /results="true"/.test(s));
    if (!next) return issues;
    const cursor = /cursor="([^"]+)"/.exec(next)?.[1];
    if (!cursor || cursors.has(cursor)) throw new Error("Sentry pagination did not advance; no tickets created.");
    cursors.add(cursor); params.set("cursor", cursor);
  }
}

export async function scanSentry(job: Job, clickupKey: string | undefined, opts: { dryRun?: boolean; deps?: Partial<Deps> } = {}): Promise<SentryScanResult> {
  const config = job.sentry;
  validateSentryConfig(config);
  if (!clickupKey) throw new Error("Sentry ticket creation needs a ClickUp API key.");
  const deps: Deps = { fetch: (...args) => fetch(...args), reserve: reserveSentryGroup, plan: async (j, g) => (await import("./sentryBundles.ts")).planSentryBundles(j, g), ...opts.deps };
  const request = async (path: string, init?: RequestInit) => (await jsonRequest(deps.fetch, `${CLICKUP}${path}`, clickupKey, init)).data;
  // Validate routing before reading/claiming issues. A folder is a selector; tasks are always created in its chosen list.
  const destination = await request(`/list/${encodeURIComponent(config.listId)}`);
  if (config.folderId && String(destination.folder?.id) !== config.folderId) throw new Error("Selected ClickUp list no longer belongs to the configured folder.");
  const spaces = await request(`/team/${encodeURIComponent(config.workspaceId)}/space?archived=false`);
  if (!Array.isArray(spaces.spaces) || !spaces.spaces.some((s: any) => String(s.id) === String(destination.space?.id))) throw new Error("ClickUp destination list does not belong to the configured workspace.");
  if (config.status && !(destination.statuses ?? []).some((s: any) => s.status === config.status)) throw new Error("Configured initial status is not available on the destination list.");
  const spaceId = String(destination.space.id);
  const tags = await request(`/space/${encodeURIComponent(spaceId)}/tag`);
  if (!Array.isArray(tags.tags)) throw new Error("ClickUp tag lookup failed.");
  const tagExists = tags.tags.some((t: any) => t.name?.toLowerCase() === config.tag.toLowerCase());
  const issues = await readSentryIssues(config, deps.fetch);
  const groups = await deps.plan(job, groupSentryIssues(issues, config));
  const readTasks = async (): Promise<any[]> => {
    const tasks: any[] = [];
    const ids = new Set<string>();
    for (let page = 0; ; page++) {
      const data = await request(`/team/${encodeURIComponent(config.workspaceId)}/task?include_closed=true&subtasks=true&include_markdown_description=true&page=${page}`);
      if (!Array.isArray(data.tasks)) throw new Error("ClickUp duplicate search failed; no task may be created.");
      const before = ids.size;
      for (const task of data.tasks) {
        if (!task.id) throw new Error("ClickUp returned an incomplete task during deduplication.");
        if (!ids.has(String(task.id))) { ids.add(String(task.id)); tasks.push(task); }
      }
      if (data.last_page === true || !data.tasks.length) return tasks;
      if (ids.size === before) throw new Error("ClickUp duplicate-search pagination did not advance.");
      if (page >= 999) throw new Error("ClickUp duplicate search exceeded its safety limit; refusing partial deduplication.");
    }
  };
  const result: SentryScanResult = { issues: issues.length, groups: groups.length, created: 0, existing: 0, reserved: 0, preview: 0, tickets: [] };
  if (!groups.length) return result;
  let tasks = await readTasks();
  let tagReady = tagExists;
  const attachToExisting = async (group: SentryGroup): Promise<boolean> => {
    const existing = tasks.find(t => matchingSentryTask(t, group));
    if (!existing) return false;
    const old = existing.markdown_description ?? existing.description ?? "";
    const missing = group.issues.filter(issue => !matchingSentryTask(existing, { ...group, key: "", issues: [issue] }));
    if (missing.length && !opts.dryRun) {
      const markdown = `${old}\n\n## Additional reports in this Sentry bundle\n${sentryTicketDescription({ ...group, issues: missing }, config)}`;
      await request(`/task/${encodeURIComponent(existing.id)}`, { method: "PUT", body: JSON.stringify({ markdown_content: markdown }) });
      existing.markdown_description = markdown;
    }
    return true;
  };
  for (const group of groups) {
    if (await attachToExisting(group)) { result.existing++; continue; }
    if (opts.dryRun) { result.preview++; continue; }
    if (!tagReady) {
      const currentTags = await request(`/space/${encodeURIComponent(spaceId)}/tag`);
      if (!(currentTags.tags ?? []).some((t: any) => t.name?.toLowerCase() === config.tag.toLowerCase())) await request(`/space/${encodeURIComponent(spaceId)}/tag`, { method: "POST", body: JSON.stringify({ tag: { name: config.tag.toLowerCase(), tag_fg: "#ffffff", tag_bg: "#6c5ce7" } }) });
      tagReady = true;
    }
    if (!(await deps.reserve(job, sentryReservationKey(config.workspaceId, group)))) { result.reserved++; continue; }
    let ownsIssues = true;
    for (const issue of [...group.issues].sort((a,b) => a.id.localeCompare(b.id))) {
      if (!(await deps.reserve(job, sentryIssueReservationKey(config.workspaceId, config, issue.id)))) { ownsIssues = false; break; }
    }
    if (!ownsIssues) { result.reserved++; continue; }
    // Another agent may have created a ticket between the initial search and our reservation.
    tasks = await readTasks();
    if (await attachToExisting(group)) { result.existing++; continue; }
    const ticket = await request(`/list/${encodeURIComponent(config.listId)}/task`, { method: "POST", body: JSON.stringify({ name: `[Sentry] ${group.title}`.slice(0, 250), markdown_content: sentryTicketDescription(group, config), tags: [config.tag.toLowerCase()], ...(config.status ? { status: config.status } : {}), notify_all: false, check_required_custom_fields: true }) });
    if (!ticket.id) throw new Error("ClickUp did not return a task id; reservation kept to prevent a duplicate. Reconcile manually.");
    result.created++; result.tickets.push(String(ticket.id));
    tasks.push({ ...ticket, markdown_description: sentryTicketDescription(group, config) });
  }
  return result;
}
