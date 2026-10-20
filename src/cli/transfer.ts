import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { HOME, host, newId, type Account, type CliState, type Job } from "./state.ts";

const run = promisify(execFile);

/**
 * Moving scanners to another machine. `export` writes one file with everything a box needs
 * to run the same scanners: the ClickUp token, Slack, the branch prefix, every account (API
 * key, or the login's credential file), and every scanner with its repo's remote URL so the
 * other box can clone it. `import` reads that file into a fresh or existing install. Tasks in
 * flight are not moved: their worktrees live on the box that started them.
 */
export type BundleAccount = { name: string; provider: Account["provider"]; auth: Account["auth"]; apiKey?: string; credentials?: { file: string; content: string } };
export type BundleScanner = Omit<Job, "id" | "lastScanAt" | "repo"> & { repoPath: string; repoRemote?: string };
export type Bundle = { kind: "consort-cli-bundle"; version: 1; exportedAt: number; host: string; clickupKey?: string; slack?: CliState["slack"]; branchPrefix?: string; accounts: BundleAccount[]; scanners: BundleScanner[] };

/** the credential file a login keeps in its own directory (Claude Code on macOS keeps it in the Keychain instead, so there may be none) */
export const credentialFile = (provider: Account["provider"]) => (provider === "claude" ? ".credentials.json" : "auth.json");

export async function buildBundle(s: CliState, opts: { only?: string[]; readFile?: (p: string) => string | undefined; remoteOf?: (repo: string) => Promise<string | undefined> } = {}): Promise<Bundle> {
  const readFile = opts.readFile ?? ((p: string) => (existsSync(p) ? readFileSync(p, "utf8") : undefined));
  const remoteOf = opts.remoteOf ?? ((repo: string) => run("git", ["-C", repo, "remote", "get-url", "origin"], { timeout: 15_000 }).then((r) => r.stdout.trim() || undefined, () => undefined));
  const accounts: BundleAccount[] = s.accounts.map((a) => {
    const content = a.auth === "login" && a.configDir ? readFile(join(a.configDir, credentialFile(a.provider))) : undefined;
    return { name: a.name, provider: a.provider, auth: a.auth, ...(a.apiKey ? { apiKey: a.apiKey } : {}), ...(content ? { credentials: { file: credentialFile(a.provider), content } } : {}) };
  });
  const scanners: BundleScanner[] = [];
  for (const j of s.jobs.filter((j) => !opts.only?.length || opts.only.includes(j.id) || opts.only.includes(j.name))) {
    const { id: _id, lastScanAt: _l, repo, ...rest } = j;
    scanners.push({ ...rest, repoPath: repo, repoRemote: await remoteOf(repo) });
  }
  return { kind: "consort-cli-bundle", version: 1, exportedAt: Date.now(), host: host(), clickupKey: s.clickupKey, slack: s.slack, branchPrefix: s.branchPrefix, accounts, scanners };
}

export type ImportReport = { added: string[]; kept: string[]; needLogin: string[]; cloned: string[] };

/**
 * Fold a bundle into this box's state: settings fill gaps (or replace, with `replace`), accounts
 * and scanners are added unless one with the same name is here already, and a scanner's repo is
 * used where the bundle's path exists here, else cloned from its remote under `repoDir`.
 */
export async function applyBundle(s: CliState, b: Bundle, opts: { repoDir?: string; replace?: boolean; exists?: (p: string) => boolean; clone?: (remote: string, into: string) => Promise<void>; writeCred?: (p: string, content: string) => void; create: (s: CliState, provider: Account["provider"], name: string, apiKey?: string) => Account }): Promise<ImportReport> {
  if (b.kind !== "consort-cli-bundle") throw new Error("not a consort-cli export file");
  const exists = opts.exists ?? existsSync;
  const clone = opts.clone ?? (async (remote: string, into: string) => { mkdirSync(join(into, ".."), { recursive: true }); await run("git", ["clone", remote, into], { timeout: 600_000 }); });
  const writeCred = opts.writeCred ?? ((p: string, content: string) => { mkdirSync(join(p, ".."), { recursive: true, mode: 0o700 }); writeFileSync(p, content, { mode: 0o600 }); });
  const create = opts.create;
  const repoDir = opts.repoDir ?? join(HOME, "repos");
  const r: ImportReport = { added: [], kept: [], needLogin: [], cloned: [] };
  const take = (k: "clickupKey" | "slack" | "branchPrefix") => { if (b[k] && (opts.replace || !s[k])) { (s as Record<string, unknown>)[k] = b[k]; r.added.push(k === "clickupKey" ? "ClickUp token" : k === "slack" ? "Slack" : "branch prefix"); } else if (b[k]) r.kept.push(k === "clickupKey" ? "ClickUp token" : k === "slack" ? "Slack" : "branch prefix"); };
  take("clickupKey"); take("slack"); take("branchPrefix");
  for (const a of b.accounts) {
    if (s.accounts.some((x) => x.provider === a.provider && x.name === a.name)) { r.kept.push(`account ${a.name}`); continue; }
    const acc = create(s, a.provider, a.name, a.apiKey);
    r.added.push(`account ${a.name}`);
    if (acc.auth === "login") { if (a.credentials && acc.configDir) writeCred(join(acc.configDir, a.credentials.file), a.credentials.content); else r.needLogin.push(acc.id); }
  }
  for (const sc of b.scanners) {
    if (s.jobs.some((x) => x.name === sc.name)) { r.kept.push(`scanner ${sc.name}`); continue; }
    const { repoPath, repoRemote, ...rest } = sc;
    let repo = repoPath;
    if (!exists(join(repoPath, ".git"))) {
      if (!repoRemote) throw new Error(`scanner ${sc.name}: ${repoPath} is not here and the export has no remote URL to clone from`);
      repo = join(repoDir, basename(repoRemote).replace(/\.git$/, ""));
      if (!exists(join(repo, ".git"))) { await clone(repoRemote, repo); r.cloned.push(`${repoRemote} → ${repo}`); }
    }
    s.jobs.push({ ...rest, id: newId("job"), repo } as Job);
    r.added.push(`scanner ${sc.name}`);
  }
  s.setupCompletedAt ??= Date.now();
  return r;
}
