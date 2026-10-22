/** Configure the Sentry producer independently from ClickUp worker scanners. */
import { clickupScopeFrom } from "../shared/headless.ts";
import type { SentryScannerConfig } from "../shared/sentryScanner.ts";
import { readSentryIssues } from "./sentry.ts";
import { DEFAULT_STATUSES, newId, type Job } from "./state.ts";

type Ask = (question: string, options?: { default?: string; secret?: boolean }) => Promise<string>;
export async function configureSentryScanner(ask: Ask, existingKey: string | undefined, repo: { repo: string; base: string }, fetcher: typeof fetch = (...args) => fetch(...args), existingJobs: Job[] = []): Promise<{ job: Job; clickupKey: string }> {
  const previous = existingJobs.find(j => j.source === "sentry" && j.repo === repo.repo)?.sentry;
  const worker = existingJobs.find(j => j.source === "clickup" && j.repo === repo.repo);
  const savedScope = previous?.folderId ? `folder:${previous.folderId}` : previous?.listId ? `list:${previous.listId}` : worker?.scope?.kind === "folder" ? `folder:${worker.scope.id}` : worker?.scope?.kind === "list" ? `list:${worker.scope.id}` : worker?.listId ? `list:${worker.listId}` : undefined;
  console.log("Reusing Consort's saved AI accounts, Slack connection and ClickUp key; bundle workers use the existing ClickUp scanner.");
  const request = async (key: string, path: string) => {
    const res = await fetcher(`https://api.clickup.com/api/v2${path}`, { headers: { Authorization: key }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`ClickUp setup HTTP ${res.status}`);
    return res.json();
  };
  const name = await ask("Name this Sentry scanner", { default: "Sentry → ClickUp" });
  const host = await ask("Sentry HTTPS host", { default: previous?.host ?? "https://sentry.io" });
  const org = await ask("Sentry organization slug", { default: previous?.org });
  const projects = (await ask("Sentry project slugs (comma-separated)", { default: previous?.projects.join(",") })).split(",").map((p) => p.trim()).filter(Boolean);
  const environments = (await ask("Environments (comma-separated; empty for all)", { default: previous?.environments.join(",") ?? "production" })).split(",").map((s) => s.trim()).filter(Boolean);
  const query = await ask("Sentry issue query", { default: previous?.query ?? "is:unresolved" });
  const token = previous?.token ?? await ask("Sentry auth token (event:read for organization issue access; never a DSN)", { secret: true });
  const clickupKey = existingKey ?? await ask("ClickUp API token for creating tasks and workspace-wide deduplication", { secret: true });
  const teams = (await request(clickupKey, "/team")).teams ?? [];
  if (!teams.length) throw new Error("ClickUp token cannot access a workspace.");
  console.log("ClickUp workspaces:", teams.map((t: any) => `${t.id}: ${t.name}`).join(" | "));
  const workspaceId = await ask("ClickUp workspace ID (deduplication searches this entire workspace)", { default: previous?.workspaceId ?? (teams.length === 1 ? String(teams[0].id) : undefined) });
  if (!teams.some((t: any) => String(t.id) === workspaceId)) throw new Error("Choose a workspace accessible to this ClickUp token.");
  const scope = clickupScopeFrom(await ask("Destination ClickUp list or folder URL/id (use folder:<id> for a bare folder ID)", { default: savedScope }));
  if (!scope || scope.kind === "space") throw new Error("Choose a ClickUp list or folder, not a space.");
  let listId = scope.id;
  if (scope.kind === "folder") {
    const lists: { id: string; name: string }[] = ((await request(clickupKey, `/folder/${encodeURIComponent(scope.id)}/list?archived=false`)).lists ?? []).map((l: any) => ({ id: String(l.id), name: String(l.name) }));
    if (!lists.length) throw new Error("Selected ClickUp folder has no lists.");
    console.log("Lists in the selected folder:", lists.map((l) => `${l.id}: ${l.name}`).join(" | "));
    listId = await ask("Which list inside that folder receives the Sentry tickets?", { default: lists.length === 1 ? lists[0].id : undefined });
    if (!lists.some((l) => l.id === listId)) throw new Error("Choose one of the selected folder's lists.");
  }
  const list = await request(clickupKey, `/list/${encodeURIComponent(listId)}`);
  const spaces = (await request(clickupKey, `/team/${encodeURIComponent(workspaceId)}/space?archived=false`)).spaces ?? [];
  if (!spaces.some((s: any) => String(s.id) === String(list.space?.id))) throw new Error("Destination list is not in the chosen workspace.");
  const tag = (await ask("Tag to put on each created ticket (align with a ClickUp worker scanner)", { default: previous?.tag ?? worker?.filters.tags?.[0] ?? "sentry" })).trim().toLowerCase();
  const statuses = (list.statuses ?? []).map((s: any) => String(s.status));
  console.log(`Destination: ${list.name} (${listId}); statuses: ${statuses.join(", ")}`);
  const status = await ask("Initial ClickUp task status", { default: previous?.status ?? worker?.filters.statuses?.[0] ?? statuses[0] });
  if (!statuses.includes(status)) throw new Error("Choose one of the destination list's statuses.");
  const everyMinutes = Number(await ask("Scan Sentry every N minutes", { default: "15" }));
  if (!Number.isFinite(everyMinutes) || everyMinutes < 1) throw new Error("Scan interval must be at least one minute.");
  const config: SentryScannerConfig = { host, org, projects, environments, query, token, workspaceId, listId, ...(scope.kind === "folder" ? { folderId: scope.id } : {}), tag, status };
  const issues = await readSentryIssues(config, fetcher);
  console.log(`Sentry connection verified: ${issues.length} matching issues. No tickets created during setup. Shared deduplication uses the GitHub repository at ${repo.repo}; all producers must use this same repository.`);
  const job: Job = { id: newId("job"), name, source: "sentry", sentry: config, ...repo, filters: {}, everyMinutes, maxParallel: 0, statuses: { ...DEFAULT_STATUSES }, enabled: true, createdAt: Date.now() };
  return { job, clickupKey };
}
