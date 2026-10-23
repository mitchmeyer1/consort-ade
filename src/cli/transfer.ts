import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { HOME, host, newId, type Account, type CliState, type Job } from "./state.ts";
import type { Resource } from "../shared/resources.ts";

const run = promisify(execFile);

/**
 * Moving scanners to another machine. `export` writes one file with everything a box needs
 * to run the same scanners: the ClickUp token, Slack, the branch prefix, every account (API
 * key, or the login's credential file), every scanner with its repo's remote URL, and every
 * project info resource with its remote URL, so the other box can clone them. `import` reads that file into a fresh or existing install. Tasks in
 * flight are not moved: their worktrees live on the box that started them.
 */
export type BundleAccount = { name: string; provider: Account["provider"]; auth: Account["auth"]; apiKey?: string; maxActiveTurns?: number; credentials?: { file: string; content: string } };
export type BundleScanner = Omit<Job, "id" | "lastScanAt" | "scanStartedAt" | "repo"> & { repoPath: string; repoRemote?: string };
export type BundleResource = { name: string; kind: Resource["kind"]; path: string; remote?: string };
export type Bundle = { kind: "consort-cli-bundle"; version: 1; exportedAt: number; host: string; capacity?: CliState["capacity"]; clickupKey?: string; slack?: CliState["slack"]; branchPrefix?: string; accounts: BundleAccount[]; scanners: BundleScanner[]; resources?: BundleResource[] };

/** the credential file a login keeps in its own directory (Claude Code on macOS keeps it in the Keychain instead, so there may be none) */
export const credentialFile = (provider: Account["provider"]) => (provider === "claude" ? ".credentials.json" : "auth.json");

export async function buildBundle(s: CliState, opts: { only?: string[]; readFile?: (p: string) => string | undefined; remoteOf?: (repo: string) => Promise<string | undefined> } = {}): Promise<Bundle> {
  const readFile = opts.readFile ?? ((p: string) => (existsSync(p) ? readFileSync(p, "utf8") : undefined));
  const remoteOf = opts.remoteOf ?? ((repo: string) => run("git", ["-C", repo, "remote", "get-url", "origin"], { timeout: 15_000 }).then((r) => r.stdout.trim() || undefined, () => undefined));
  const accounts: BundleAccount[] = s.accounts.map((a) => {
    const content = a.auth === "login" && a.configDir ? readFile(join(a.configDir, credentialFile(a.provider))) : undefined;
    return { name: a.name, provider: a.provider, auth: a.auth, ...(a.maxActiveTurns ? { maxActiveTurns: a.maxActiveTurns } : {}), ...(a.apiKey ? { apiKey: a.apiKey } : {}), ...(content ? { credentials: { file: credentialFile(a.provider), content } } : {}) };
  });
  const scanners: BundleScanner[] = [];
  for (const j of s.jobs.filter((j) => !opts.only?.length || opts.only.includes(j.id) || opts.only.includes(j.name))) {
    const { id: _id, lastScanAt: _l, scanStartedAt: _scan, repo, ...rest } = j;
    scanners.push({ ...rest, repoPath: repo, repoRemote: await remoteOf(repo) });
  }
  const resources: BundleResource[] = [];
  for (const r of s.resources ?? []) resources.push({ name: r.name, kind: r.kind, path: r.path, remote: await remoteOf(r.path) });
  return { kind: "consort-cli-bundle", version: 1, exportedAt: Date.now(), host: s.hostId ?? host(), capacity: s.capacity, clickupKey: s.clickupKey, slack: s.slack, branchPrefix: s.branchPrefix, accounts, scanners, ...(resources.length ? { resources } : {}) };
}

/** `notes`: what was imported without a piece it needed, and how to finish it by hand */
export type ImportReport = { added: string[]; kept: string[]; needLogin: string[]; cloned: string[]; notes: string[] };

/**
 * Fold a bundle into this box's state: settings fill gaps (or replace, with `replace`), accounts
 * and scanners are added unless one with the same name is here already, and a scanner's repo is
 * used where the bundle's path exists here, else cloned from its remote under `repoDir`. A project
 * info resource is found or cloned the same way; one that is neither is left out with a note,
 * since a task runs without it.
 */
export async function applyBundle(s: CliState, b: Bundle, opts: { repoDir?: string; replace?: boolean; exists?: (p: string) => boolean; clone?: (remote: string, into: string) => Promise<void>; writeCred?: (p: string, content: string) => void; create: (s: CliState, provider: Account["provider"], name: string, apiKey?: string) => Account }): Promise<ImportReport> {
  if (b.kind !== "consort-cli-bundle") throw new Error("not a consort-cli export file");
  const exists = opts.exists ?? existsSync;
  const clone = opts.clone ?? (async (remote: string, into: string) => { mkdirSync(join(into, ".."), { recursive: true }); await run("git", ["clone", remote, into], { timeout: 600_000 }); });
  const writeCred = opts.writeCred ?? ((p: string, content: string) => { mkdirSync(join(p, ".."), { recursive: true, mode: 0o700 }); writeFileSync(p, content, { mode: 0o600 }); });
  const create = opts.create;
  const repoDir = opts.repoDir ?? join(HOME, "repos");
  const r: ImportReport = { added: [], kept: [], needLogin: [], cloned: [], notes: [] };
  // a checkout the bundle names: that path when it exists here, else a clone of its remote under repoDir
  const checkout = async (path: string, remote: string | undefined): Promise<string | undefined> => {
    if (exists(join(path, ".git"))) return path;
    if (!remote) return undefined;
    const into = join(repoDir, basename(remote).replace(/\.git$/, ""));
    if (!exists(join(into, ".git"))) { await clone(remote, into); r.cloned.push(`${remote} → ${into}`); }
    return into;
  };
  const take = (k: "clickupKey" | "slack" | "branchPrefix") => { if (b[k] && (opts.replace || !s[k])) { (s as Record<string, unknown>)[k] = b[k]; r.added.push(k === "clickupKey" ? "ClickUp token" : k === "slack" ? "Slack" : "branch prefix"); } else if (b[k]) r.kept.push(k === "clickupKey" ? "ClickUp token" : k === "slack" ? "Slack" : "branch prefix"); };
  take("clickupKey"); take("slack"); take("branchPrefix");
  if (b.capacity && (opts.replace || !s.capacity)) s.capacity = b.capacity;
  for (const a of b.accounts) {
    if (s.accounts.some((x) => x.provider === a.provider && x.name === a.name)) { r.kept.push(`account ${a.name}`); continue; }
    const acc = create(s, a.provider, a.name, a.apiKey);
    if (a.maxActiveTurns) acc.maxActiveTurns = a.maxActiveTurns;
    r.added.push(`account ${a.name}`);
    if (acc.auth === "login") { if (a.credentials && acc.configDir) writeCred(join(acc.configDir, a.credentials.file), a.credentials.content); else r.needLogin.push(acc.id); }
  }
  for (const sc of b.scanners) {
    if (s.jobs.some((x) => x.name === sc.name)) { r.kept.push(`scanner ${sc.name}`); continue; }
    const { repoPath, repoRemote, ...rest } = sc;
    const repo = await checkout(repoPath, repoRemote);
    if (!repo) throw new Error(`scanner ${sc.name}: ${repoPath} is not here and the export has no remote URL to clone from`);
    s.jobs.push({ ...rest, id: newId("job"), repo } as Job);
    r.added.push(`scanner ${sc.name}`);
  }
  for (const res of b.resources ?? []) {
    if ((s.resources ?? []).some((x) => x.name === res.name)) { r.kept.push(`resource ${res.name}`); continue; }
    const path = await checkout(res.path, res.remote).catch(() => undefined);
    if (!path) { r.notes.push(`resource ${res.name}: ${res.path} is not here and could not be cloned; imported without it (consort-cli resources add --name ${res.name} --markdown <path>)`); continue; }
    (s.resources ??= []).push({ id: newId("res"), name: res.name, kind: res.kind, path });
    r.added.push(`resource ${res.name}`);
  }
  s.setupCompletedAt ??= Date.now();
  return r;
}
