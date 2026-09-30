import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { SHIP_LABELS, stageLabel, type ShipFeature, type ShipStage, type ShipTicket } from "../shared/ship";

const run = promisify(execFile);
const gh = async (cwd: string, args: string[]) => (await run("gh", args, { cwd, timeout: 60_000, maxBuffer: 1 << 22 })).stdout;
const CLICKUP = "https://api.clickup.com/api/v2";

/**
 * The ticket side of /ship: reading a GitHub issue or ClickUp task into a ticket, and writing
 * the stage back. GitHub carries the stage as one `ship:<stage>` label at a time and the issue
 * closes on Merged; ClickUp carries it as the task status, which must exist on the list.
 * Everything here is best effort for the caller: a ticket that cannot be reached is recorded
 * on the feature's `sync`, never a blocked pipeline.
 */
export async function githubTicket(repoPath: string, number: number): Promise<ShipTicket & { body: string }> {
  const j = JSON.parse(await gh(repoPath, ["issue", "view", String(number), "--json", "number,title,url,body"]));
  return { source: "github", id: String(j.number), url: j.url, title: j.title, repo: repoOf(j.url), body: j.body ?? "" };
}

export async function createGithubIssue(repoPath: string, title: string, body: string): Promise<ShipTicket & { body: string }> {
  const url = (await gh(repoPath, ["issue", "create", "--title", title, "--body", body])).trim().split("\n").pop() ?? "";
  const number = Number(/\/issues\/(\d+)/.exec(url)?.[1]);
  if (!number) throw new Error(`gh issue create returned no issue url: ${url}`);
  return githubTicket(repoPath, number);
}

const repoOf = (url: string) => /github\.com\/([^/]+\/[^/]+)\//.exec(url)?.[1];
const LABEL_COLORS: Record<ShipStage, string> = { Grilling: "c5def5", "Spec'd": "bfd4f2", Implementing: "fbca04", "Ready to Test": "d4c5f9", Revising: "f9d0c4", "In Review": "0e8a16", Merged: "5319e7", Closed: "cccccc" };

/** the eight labels, created or refreshed; `--force` makes a rerun harmless */
export async function ensureShipLabels(repoPath: string) {
  for (const stage of Object.keys(LABEL_COLORS) as ShipStage[])
    await gh(repoPath, ["label", "create", stageLabel(stage), "--color", LABEL_COLORS[stage], "--description", `/ship stage: ${stage}`, "--force"]);
}

export async function setGithubStage(repoPath: string, number: string, stage: ShipStage) {
  const label = stageLabel(stage);
  const args = ["issue", "edit", number, "--add-label", label];
  for (const other of SHIP_LABELS) if (other !== label) args.push("--remove-label", other);
  try { await gh(repoPath, args); }
  catch (e) {
    // a label that does not exist yet fails the whole edit: create them and retry once
    if (!/not found|does not exist|could not add label/i.test(String((e as Error).message))) throw e;
    await ensureShipLabels(repoPath);
    await gh(repoPath, args);
  }
}
export const commentGithub = (repoPath: string, number: string, body: string) => gh(repoPath, ["issue", "comment", number, "--body", body]);
export const closeGithub = (repoPath: string, number: string, comment?: string) => gh(repoPath, ["issue", "close", number, ...(comment ? ["--comment", comment] : [])]);

async function clickup(key: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${CLICKUP}${path}`, { ...init, headers: { Authorization: key, "Content-Type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickUp ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

export async function clickupTicket(key: string, id: string): Promise<ShipTicket & { body: string; status?: string }> {
  const t = await clickup(key, `/task/${encodeURIComponent(id)}`);
  return { source: "clickup", id: String(t.id), url: t.url ?? `https://app.clickup.com/t/${t.id}`, title: t.name ?? String(t.id), body: t.markdown_description ?? t.description ?? "", status: t.status?.status };
}
/** the ClickUp status is the stage name in lower case, as Peter's list is set up */
export const setClickupStatus = (key: string, id: string, stage: ShipStage) => clickup(key, `/task/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ status: stage.toLowerCase() }) });
export const commentClickup = (key: string, id: string, text: string) => clickup(key, `/task/${encodeURIComponent(id)}/comment`, { method: "POST", body: JSON.stringify({ comment_text: text }) });

export type SyncDeps = { repoPath: string; clickupKey?: string };

/**
 * Writes a stage change to the ticket: the label or status, a comment with the note, the spec
 * on Spec'd, and the close on Merged. Returns the sync record for the feature.
 */
export async function syncTicket(f: ShipFeature, note: string | undefined, deps: SyncDeps, worktreePath: string): Promise<ShipFeature["sync"]> {
  const t = f.ticket;
  try {
    const spec = f.stage === "Spec'd" && f.spec ? readSpec(worktreePath, f.spec) : undefined;
    const comment = [note ? `/ship → ${f.stage}: ${note}` : `/ship → ${f.stage}`, ...f.prs.map((p) => `PR: ${p}`), ...(spec ? ["", spec] : [])].join("\n");
    if (t.source === "github") {
      if (f.stage === "Merged" || f.stage === "Closed") {
        await setGithubStage(deps.repoPath, t.id, f.stage);
        await closeGithub(deps.repoPath, t.id, comment);
      } else {
        await setGithubStage(deps.repoPath, t.id, f.stage);
        await commentGithub(deps.repoPath, t.id, comment);
      }
    } else {
      if (!deps.clickupKey) throw new Error("No ClickUp API key in Settings.");
      await setClickupStatus(deps.clickupKey, t.id, f.stage);
      await commentClickup(deps.clickupKey, t.id, comment);
    }
    return { at: Date.now(), ok: true };
  } catch (e) {
    return { at: Date.now(), ok: false, error: String((e as Error).message ?? e).split("\n")[0] };
  }
}

const readSpec = (worktreePath: string, rel: string) => {
  const p = join(worktreePath, rel);
  return existsSync(p) ? readFileSync(p, "utf8").slice(0, 60_000) : undefined;
};

/** the ticket's body for grilling: the issue text, or the ClickUp description */
export async function ticketBody(t: ShipTicket, deps: SyncDeps): Promise<string> {
  try {
    if (t.source === "github") return (await githubTicket(deps.repoPath, Number(t.id))).body;
    if (deps.clickupKey) return (await clickupTicket(deps.clickupKey, t.id)).body;
  } catch {}
  return "";
}

/** keeps Consort's folder (uploads, screenshots, /ship artifacts) out of git for every worktree of the repo */
export async function excludeConsortDir(worktreePath: string) {
  const exclude = (await run("git", ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { cwd: worktreePath })).stdout.trim();
  let current = "";
  try { current = readFileSync(exclude, "utf8"); } catch {}
  if (current.split(/\r?\n/).includes("/.consort/")) return;
  appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}/.consort/\n`);
}
