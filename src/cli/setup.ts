import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createPrompter as prompter, type Ask } from "./prompter";
import { promisify } from "node:util";
import { cliStatus } from "../main/cliRuntime";
import { accountStatus, loginInteractive, runtimeDeps } from "./agent";
import { configureSentryScanner } from "./sentrySetup";
import { Slack } from "./slack";
import { clickupLists, clickupSource } from "./sources";
import { DEFAULT_STATUSES, loadState, LOGINS_DIR, newId, saveState, STATE_FILE, WORK_DIR, type Account, type CliState, type Job } from "./state";

/**
 * `consort-cli setup`: the one walk-through that gets a box from nothing to `consort-cli run`.
 * Tooling first (git, gh, the agent binaries), then the issue sources with their keys tested
 * against the real APIs, then at least one AI account (logged in to this tool's own directory,
 * never the desktop app's), then Slack with a message you confirm you saw. Each step saves as
 * it goes, so a crash or ctrl-c resumes where it left. The final flag is what every other
 * command checks for.
 */

import { bad, banner, dim, head, mint, ok } from "./theme";
import { resourceProblem } from "../shared/resources.ts";
import { DEFAULT_COVERED_SERVICE, describeKeyRef, phiSettings, type CoveredKeyRef } from "../shared/phi.ts";
import { checkCoveredKey } from "./covered";
import { shellExposure, storeKeychainKey } from "./phiCommands";
import { findBrowser } from "./evidence";

const run = promisify(execFile);

import { chooseFrom, clickupListIdFrom, clickupScopeFrom, masked, slackUserIdFrom, type ClickupScope } from "../shared/headless.ts";
export { chooseFrom, clickupListIdFrom, slackUserIdFrom };
/** the default name for a new scanner: Consort Watcher, numbered once there is more than one */
export const scannerName = (s: Pick<CliState, "jobs">) => (s.jobs.length ? `Consort Watcher ${s.jobs.length + 1}` : "Consort Watcher");
export const setupDone = (s: Pick<CliState, "setupCompletedAt">) => !!s.setupCompletedAt;

const yes = async (ask: Ask, q: string, dflt = true) => /^y/i.test(await ask(`${q} (${dflt ? "Y/n" : "y/N"})`, { default: dflt ? "y" : "n" }));
/** a step that already has a value: show it, and "y" (or Enter) keeps it; "n" asks again */
const keep = async (ask: Ask, what: string, value: string, dflt = true) => { console.log(`${dim("Saved")} ${what}: ${value}`); return yes(ask, "Keep it?", dflt); };

/** before each credential: what it is for, where to get it, and what it lets consort-cli do */
const why = (title: string, lines: { for: string; where: string; needs?: string[]; can: string; not?: string }) => {
  console.log(`\n${mint(title)}`);
  console.log(`  ${dim("Used for")}   ${lines.for}`);
  console.log(`  ${dim("Where")}      ${lines.where}`);
  if (lines.needs) { console.log(`  ${dim("It needs")}   ${lines.needs[0]}`); for (const l of lines.needs.slice(1)) console.log(`             ${l}`); }
  console.log(`  ${dim("It can")}     ${lines.can}`);
  if (lines.not) console.log(`  ${dim("It cannot")}  ${lines.not}`);
};

/** the Slack bot token scopes consort-cli calls, one line each: what the scope is for, so a missing one is obvious. docs/slack-app-manifest.json asks for the same set. */
const SLACK_SCOPES: readonly [scope: string, reason: string][] = [
  ["chat:write", "post progress and questions as the bot"],
  ["files:write", "post the PR article in a review thread when asking you to approve"],
  ["im:write", "open the DM with you"],
  ["im:history", "read your replies in the DM thread; without it the bot can post but never hear you"],
  ["pins:write", "pin the master monitor post in the DM"],
  ["files:read", "download documents you attach to a task update in the thread"],
  ["channels:history", "only if you point it at a public channel instead of the DM (groups:history for a private one)"],
];
const slackScopeLines = () => SLACK_SCOPES.map(([scope, reason]) => `${scope.padEnd(17)} ${reason}`);

async function checkTools(): Promise<boolean> {
  console.log(head("1. Tools on this machine"));
  let fine = true;
  const tool = async (name: string, args: string[], must: boolean) => {
    try { const v = (await run(name, args, { timeout: 15_000 })).stdout.trim().split("\n")[0]; console.log(ok(`${name}: ${v}`)); return true; }
    catch { console.log((must ? bad : ok)(`${name}: not found${must ? "" : " (optional)"}`)); if (must) fine = false; return false; }
  };
  await tool("git", ["--version"], true);
  if (await tool("gh", ["--version"], true)) {
    const authed = await run("gh", ["auth", "status"], { timeout: 15_000 }).then(() => true, () => false);
    console.log(authed ? ok("gh is signed in") : bad("gh is not signed in: run `gh auth login` (it needs repo and read:org scopes), then rerun setup"));
    if (!authed) fine = false;
  }
  for (const p of ["claude", "codex"] as const) {
    const st = await cliStatus(p, runtimeDeps);
    console.log(st.version ? ok(`${p === "claude" ? "Claude Code" : "Codex"} binary ${st.version} (${st.source})`) : bad(`${p === "claude" ? "Claude Code" : "Codex"} binary missing for ${process.platform}-${process.arch}: run \`pnpm install\` here, or \`consort-cli cli update\``));
  }
  const browser = await findBrowser();
  console.log(browser ? ok(`headless Chrome for evidence screenshots: ${browser}`) : `${dim("–")} no Chrome or Chromium found: frontend evidence will pause until a browser is installed (install google-chrome or chromium, or set CONSORT_CHROME)`);
  mkdirSync(WORK_DIR, { recursive: true });
  console.log(ok(`state at ${STATE_FILE} (mode 600), worktrees under ${WORK_DIR}`));
  return fine;
}

async function testClickupKey(key: string): Promise<string | undefined> {
  const res = await fetch("https://api.clickup.com/api/v2/user", { headers: { Authorization: key }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
  if (!res?.ok) return undefined;
  const j = await res.json();
  return j.user?.username ?? j.user?.email ?? "ok";
}
/** a scope as the wizard shows it: its name, the lists it holds, and the statuses across them */
async function describeScope(key: string, scope: ClickupScope): Promise<{ name: string; lists: { id: string; name: string }[]; statuses: string[] } | undefined> {
  const get = async (path: string) => { const res = await fetch(`https://api.clickup.com/api/v2${path}`, { headers: { Authorization: key }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined); return res?.ok ? res.json() : undefined; };
  const self = await get(`/${scope.kind}/${encodeURIComponent(scope.id)}`);
  if (!self) return undefined;
  const lists = await clickupLists(key, scope).catch(() => [] as { id: string; name: string }[]);
  const statuses: string[] = [];
  for (const l of lists.slice(0, 40)) { const j = await get(`/list/${encodeURIComponent(l.id)}`); for (const s of (j?.statuses ?? []) as any[]) { const n = String(s.status); if (!statuses.some((x) => x.toLowerCase() === n.toLowerCase())) statuses.push(n); } }
  return { name: String(self.name ?? scope.id), lists, statuses };
}
async function testAnthropicKey(key: string): Promise<boolean> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
  return !!res?.ok;
}
async function testOpenAiKey(key: string): Promise<boolean> {
  const res = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
  return !!res?.ok;
}

async function repoChecks(ask: Ask, purpose: "build" | "review" = "build"): Promise<{ repo: string; base: string } | undefined> {
  for (;;) {
    why("Repository checkout", purpose === "review" ? {
      for: "the repository whose PRs you review; each review checks the PR head out in its own worktree beside it, never inside your checkout.",
      where: "an existing `git clone` on this machine with a remote named origin that `gh` can see.",
      can: "fetch PR heads, and post reviews and comments through your `gh` login.",
      not: "push to anyone's branch or merge; approving waits for your yes on Slack.",
    } : {
      for: "the base every feature branch is cut from; worktrees are made beside it, never inside your checkout.",
      where: "an existing `git clone` on this machine, on its base branch, with a remote named origin that `gh` can see.",
      can: "fetch, create branches, push them and open PRs through your `gh` login.",
      not: "merge; merging stays yours.",
    });
    const repo = resolve(await ask("Path of the repository checkout on this machine"));
    if (!existsSync(join(repo, ".git"))) { console.log(bad(`${repo} has no .git; clone it first`)); if (!(await yes(ask, "Try another path?"))) return undefined; continue; }
    const current = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo }).catch(() => ({ stdout: "" }))).stdout.trim();
    // a review uses each PR's own target branch, so there is nothing to ask
    const base = purpose === "review" ? (current && current !== "HEAD" ? current : "main") : await ask("Base branch features are cut from and PRs target", { default: current && current !== "HEAD" ? current : "main" });
    const remote = await run("git", ["ls-remote", "--heads", "origin", base], { cwd: repo, timeout: 60_000 }).then((r) => r.stdout.trim(), () => "");
    console.log(remote ? ok(`origin/${base} exists`) : bad(`origin has no branch ${base}; check the name`));
    const ghRepo = await run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: repo, timeout: 30_000 }).then((r) => r.stdout.trim(), () => "");
    console.log(ghRepo ? ok(`gh sees ${ghRepo}`) : bad("gh cannot see this repo on GitHub; PRs and issues will fail"));
    if (remote && ghRepo) return { repo, base };
    if (!(await yes(ask, "Keep this repo anyway?", false))) continue;
    return { repo, base };
  }
}

/** create an account record (and its own login directory) the same way `accounts add` does */
export function createAccount(s: CliState, provider: Account["provider"], name: string | undefined, apiKey?: string): Account {
  const id = newId(provider);
  const account: Account = { id, name: name ?? `${provider} ${s.accounts.filter((x) => x.provider === provider).length + 1}`, provider, auth: apiKey ? "key" : "login", createdAt: Date.now(), ...(apiKey ? { apiKey } : { configDir: join(LOGINS_DIR, id) }) };
  if (account.configDir) mkdirSync(account.configDir, { recursive: true, mode: 0o700 });
  s.accounts.push(account);
  saveState(s);
  return account;
}


/**
 * The scanner questions, one kind after another until the owner stops: shared by `setup` and the
 * `scanners add clickup|github|review|sentry` wizard. `first` skips the "which source" question once.
 */
async function addScanners(ask: Ask, first?: string): Promise<void> {
  let s = loadState();
  for (;;) {
    const kind = (first ?? (await ask("Source: clickup, github, sentry or review (automatic PR reviews)", { default: "clickup" }))).toLowerCase();
    first = undefined;
    if (kind !== "clickup" && kind !== "github" && kind !== "sentry" && kind !== "review") { console.log(bad("type clickup, github, sentry or review")); continue; }
    if (kind === "review") {
      console.log(dim("A review scanner does your reviews: it watches a repository's open PRs that request your review, and gives each one a full review (Fable/Astra overview, an Opus/Sol reviewer swarm, verified findings posted as one GitHub review). Critical or High findings request changes; otherwise it asks you on Slack before approving."));
      const repo = await repoChecks(ask, "review");
      if (!repo) continue;
      const me = await run("gh", ["api", "user", "--jq", ".login"], { cwd: repo.repo, timeout: 30_000 }).then((r) => r.stdout.trim(), () => "");
      const login = (await ask("Your GitHub login (it reviews PRs that request your review)", me ? { default: me } : {})).trim().replace(/^@/, "");
      if (!login) { console.log(bad("a GitHub login is required")); continue; }
      s = loadState();
      const name = await ask("Name this scanner", { default: `reviews for @${login}` });
      // each review runs its own swarm of agents; start with one at a time and raise it with scanners configure --max-open-tasks
      const atOnce = Math.max(1, Number(await ask("PRs to review at once", { default: "1" })) || 1);
      s.jobs.push({ id: newId("job"), name, source: "review", reviewer: login, repo: repo.repo, base: repo.base, filters: {}, everyMinutes: 5, maxParallel: 4, maxOpenTasks: atOnce, statuses: { ...DEFAULT_STATUSES }, enabled: true, createdAt: Date.now() } as Job);
      saveState(s);
      console.log(ok(`review scanner saved: PRs for @${login} in ${repo.repo}, ${atOnce} at a time, checked every 5 minutes`));
      if (await yes(ask, "Add another scanner?", false)) continue;
      break;
    }
    if (kind === "sentry") {
      console.log(dim("Sentry plans bug bundles with existing AI accounts, then creates one ClickUp ticket per bundle. Select the shared GitHub checkout used for atomic duplicate reservations; existing worker scanners pick up the output list/tag."));
      const repo = await repoChecks(ask);
      if (!repo) continue;
      try {
        const configured = await configureSentryScanner(ask, loadState().clickupKey, repo, undefined, loadState().jobs);
        s = loadState(); s.clickupKey = configured.clickupKey; s.jobs.push(configured.job, configured.worker); saveState(s);
        console.log(ok(`Sentry scanner saved: ClickUp list ${configured.job.sentry!.listId}, tag ${configured.job.sentry!.tag}. Linked worker enabled; at most ${configured.job.maxParallel} Sentry ticket(s) open at once.`));
      } catch (e) { console.log(bad(`Sentry setup failed: ${(e as Error).message}`)); }
      if (await yes(ask, "Add another scanner?", false)) continue;
      break;
    }
    const job: Partial<Job> = { id: newId("job"), source: kind as Job["source"], filters: {}, everyMinutes: 1, maxParallel: 2, statuses: { ...DEFAULT_STATUSES }, enabled: true, createdAt: Date.now() };
    if (kind === "clickup") {
      s = loadState();
      let key = s.clickupKey;
      if (key) {
        const who = await testClickupKey(key);
        if (!(await keep(ask, "ClickUp API token", `${masked(key)} ${who ? ok(`works (${who})`) : bad("does not work any more")}`, !!who))) key = undefined;
      }
      if (!key) why("ClickUp API token", {
        for: "finding tickets to work on, claiming them, moving their status and commenting progress and evidence.",
        where: "ClickUp → your avatar (bottom left) → Settings → Apps → API Token → Generate. It is a personal token, so the comments appear as you.",
        can: "read every list you can see; write comments, statuses and attachments on tasks in those lists.",
        not: "see anything your own account cannot.",
      });
      while (!key || !(await testClickupKey(key))) {
        key = await ask("ClickUp API token (pk_…)", { secret: true });
        const who = await testClickupKey(key);
        console.log(who ? ok(`key works (${who})`) : bad("ClickUp rejected that key"));
        if (!who) key = undefined;
      }
      s.clickupKey = key; saveState(s);
      let list: { name: string; lists: { id: string; name: string }[]; statuses: string[] } | undefined;
      while (!list) {
        const scope = clickupScopeFrom(await ask("ClickUp list, folder or space to watch (paste its URL from the sidebar, or an id)"));
        if (!scope) { console.log(bad("that is not a ClickUp list, folder or space URL or id")); continue; }
        list = await describeScope(key, scope);
        if (!list) { console.log(bad(`ClickUp has no ${scope.kind} with that id for this key`)); continue; }
        if (!list.lists.length) { console.log(bad(`${scope.kind} "${list.name}" has no lists`)); list = undefined; continue; }
        job.scope = scope;
        if (scope.kind === "list") job.listId = scope.id;
        console.log(ok(`${scope.kind} "${list.name}": ${list.lists.length} list${list.lists.length === 1 ? "" : "s"}${scope.kind !== "list" ? ` (${list.lists.slice(0, 6).map((l) => l.name).join(", ")}${list.lists.length > 6 ? ", …" : ""})` : ""}; statuses: ${list.statuses.join(" · ")}`));
      }
      console.log(dim("This makes a scanner: it checks that place every minute and hands each ticket that matches to a worker agent. The name only tells scanners apart in lists and Slack."));
      job.name = await ask("Name this scanner", { default: scannerName(s) });
      const tags = await ask("Only tasks with one of these tags (comma-separated; empty for any)", { default: "ai-handle" });
      job.filters!.tags = tags.split(",").map((t) => t.trim()).filter(Boolean);
      console.log("Statuses the scanner picks tasks up from:"); list.statuses.forEach((st, i) => console.log(`  ${i + 1}. ${st}`));
      job.filters!.statuses = chooseFrom(await ask("Pick by number or name (comma-separated; empty for any)", { default: "1" }), list.statuses);
      job.statuses = {
        progress: chooseFrom(await ask("Status to set while working", { default: list.statuses.find((x) => /progress/i.test(x)) ?? DEFAULT_STATUSES.progress }), list.statuses)[0] ?? DEFAULT_STATUSES.progress,
        review: chooseFrom(await ask("Status to set when the PR is up", { default: list.statuses.find((x) => /review/i.test(x)) ?? DEFAULT_STATUSES.review }), list.statuses)[0] ?? DEFAULT_STATUSES.review,
        done: chooseFrom(await ask("Status to set when the PR is merged", { default: list.statuses.find((x) => /complete|done|closed/i.test(x)) ?? DEFAULT_STATUSES.done }), list.statuses)[0] ?? DEFAULT_STATUSES.done,
      };
    } else {
      console.log(dim("This makes a scanner: it checks the repo's issues every minute and hands each one that matches to a worker agent. The name only tells scanners apart in lists and Slack."));
      job.name = await ask("Name this scanner", { default: scannerName(s) });
      const labels = await ask("Only issues with one of these labels (comma-separated; empty for any)", { default: "ai-handle" });
      job.filters!.tags = labels.split(",").map((t) => t.trim()).filter(Boolean);
    }
    const sub = await ask("Only titles containing this text (empty for any)");
    if (sub) job.filters!.nameIncludes = [sub];
    const repo = await repoChecks(ask);
    if (!repo) { console.log("Skipping this source."); if (await yes(ask, "Try a different scanner?", false)) continue; break; }
    job.repo = repo.repo; job.base = repo.base;
    if (kind === "github") {
      const n = await run("gh", ["issue", "list", "--state", "open", "--limit", "5", "--json", "number"], { cwd: job.repo, timeout: 30_000 }).then((r) => JSON.parse(r.stdout).length, () => -1);
      console.log(n >= 0 ? ok(`gh can list issues here (${n} open among the first five)`) : bad("gh cannot list issues in this repo"));
    }
    job.everyMinutes = Number(await ask("Scan every N minutes", { default: "1" })) || 1;
    job.maxParallel = Number(await ask("Tickets this scanner works on at once", { default: "2" })) || 2;
    s = loadState(); s.jobs.push(job as Job); saveState(s);
    console.log(ok(`scanner "${job.name}" saved`));
    if (!(await yes(ask, "Add another scanner? (a ClickUp worker, GitHub worker, or Sentry ticket producer)", false))) break;
  }
}

/** `consort-cli scanners add [clickup|github|review|sentry]`: the setup questions for one scanner, nothing else */
export async function runScannerWizard(kind?: string): Promise<void> {
  const { ask, close } = prompter();
  try {
    console.log(head(kind ? `Add a ${kind === "review" ? "PR review" : kind === "sentry" ? "Sentry" : kind === "github" ? "GitHub issues" : "ClickUp"} scanner` : "Add a scanner"));
    await addScanners(ask, kind);
    const s = loadState();
    if (s.jobs.some((j) => j.source === "clickup" || j.source === "github") && !s.branchPrefix) {
      const prefix = await ask("Branch prefix for the branches it creates (e.g. bot → bot/<slug>-<id>)", { default: "bot" });
      const fresh = loadState(); fresh.branchPrefix = prefix.replace(/^\/+|\/+$/g, ""); saveState(fresh);
    }
    const after = loadState();
    if (!after.accounts.length) console.log(bad("No AI accounts yet: consort-cli accounts add --provider claude|codex, or consort-cli setup"));
    if (!after.slack) console.log(bad("Slack is not set up, so agents cannot ask you anything (and reviews never approve): consort-cli setup"));
    console.log(dim(`The running daemon picks the new scanner up on its next pass; start it with consort-cli run -d if it is not running.`));
  } catch (e) {
    if (/readline was closed|closed/i.test(String((e as Error).message))) { console.log("\nStopped; any scanner already saved stays saved."); return; }
    throw e;
  } finally { close(); }
}

/** notes checkouts every Grilling reads; each must be a git checkout that is not one of the scanners' own repositories */
async function resourceSteps(ask: Ask): Promise<void> {
  why("Project info resources", {
    for: "Grilling sends one read-only reader into each, so the planner asks you less and never recommends undoing a decision your notes already record.",
    where: "a local git clone of markdown notes on your systems' decisions, processes and gotchas (a team second brain or vault); pulled at the start of every task.",
    needs: ["only notes whose contents may be quoted in PRs, Slack and ticket comments: no patient or personal data, no secrets.", "Consort cannot check that; keeping the notes clean is yours."],
    can: "be read, offline, by one reader per resource during Grilling.",
    not: "be written to, or be seen by the agents that plan or build; they get the reader's report.",
  });
  let s = loadState();
  for (const r of [...(s.resources ?? [])]) {
    if (!(await keep(ask, `resource "${r.name}"`, `${r.kind} notes at ${r.path}`))) { s = loadState(); s.resources = (s.resources ?? []).filter((x) => x.id !== r.id); saveState(s); console.log(`resource "${r.name}" removed`); }
  }
  for (;;) {
    const answer = await ask("Path of a markdown notes checkout to add (empty to finish)");
    if (!answer) return;
    const path = resolve(answer);
    s = loadState();
    const problem = resourceProblem(path, s.jobs.map((j) => j.repo), existsSync);
    if (problem) { console.log(bad(problem)); continue; }
    const name = await ask("A name for it, shown in reports", { default: basename(path) });
    if ((s.resources ?? []).some((r) => r.name === name)) { console.log(bad(`a resource named ${name} already exists`)); continue; }
    const commit = await run("git", ["-C", path, "rev-parse", "--short", "HEAD"], { timeout: 15_000 }).then((x) => x.stdout.trim(), () => "");
    (s.resources ??= []).push({ id: newId("res"), name, kind: "markdown", path }); saveState(s);
    console.log(ok(`resource "${name}": markdown notes at ${path}${commit ? ` (${commit})` : ""}`));
  }
}

/** the PHI/PII guard: on or off, and where the covered key lives; Consort stores the reference only */
async function phiSteps(ask: Ask, terminal: { pause: () => void; resume: () => void }): Promise<void> {
  why("PHI/PII guard", {
    for: "keeping member-level data out of sessions the organisation's BAA does not cover: subscription logins and Codex. On, every agent gets the member-data rules, Codex sits out, and a member-data question goes to one covered analyst turn whose answer passes a PII gate before anything else sees it.",
    where: "the covered (BAA) Anthropic key stays where you keep it: a Keychain item on macOS, or a file only you can read. Consort stores only that reference; the covered turn's own Claude Code fetches the key, so it is in no environment variable an agent could print.",
    can: "run read-only warehouse queries (snow, snowsql) over the tables a question names, in a scratch folder with no web, no files and no saved transcript.",
    not: "be exported, printed, or reach any other agent.",
  });
  let s = loadState();
  const phi = phiSettings(s);
  if (s.phi && await keep(ask, "PHI/PII guard", `${phi.guard ? "on" : "off"} · covered key ${describeKeyRef(s.covered)}`)) return;
  const on = await yes(ask, "Turn the PHI/PII guard on?", phi.guard);
  s = loadState(); s.phi = { ...s.phi, guard: on }; saveState(s);
  if (!on) { console.log(dim("Guard off: agents are not told to keep member data out, and Codex runs.")); return; }
  for (;;) {
    const kind = (await ask("Where is the covered key: keychain or file", { default: process.platform === "darwin" ? "keychain" : "file" })).toLowerCase();
    let ref: CoveredKeyRef;
    if (kind === "keychain") {
      const service = await ask("Keychain service", { default: s.covered?.kind === "keychain" ? s.covered.service : DEFAULT_COVERED_SERVICE });
      const account = await ask("Keychain account (empty for the first item with that service)");
      ref = { kind: "keychain", service, ...(account ? { account } : {}) };
    } else if (kind === "file") ref = { kind: "file", path: resolve(await ask("Path of a file holding only the key (chmod 600)")) };
    else { console.log(bad("type keychain or file")); continue; }
    let found = await checkCoveredKey(ref);
    if (!found.ok && ref.kind === "keychain" && await yes(ask, `${found.reason}. Store the key there now? security asks for it; Consort never sees it`, true)) {
      terminal.pause();
      const stored = await storeKeychainKey(ref.service, ref.account ?? "consort-cli");
      terminal.resume();
      if (stored) { ref = { ...ref, account: ref.account ?? "consort-cli" }; found = await checkCoveredKey(ref); }
    }
    s = loadState(); s.covered = ref; saveState(s);
    console.log(found.ok ? ok(`covered key: ${describeKeyRef(ref)} (found; its value is never read here)`) : bad(`covered key: ${describeKeyRef(ref)} saved, but ${found.reason}; the covered analyst stays unavailable until it is there`));
    break;
  }
  const exposed = await shellExposure();
  if (exposed.length) console.log(bad(`your shell startup files export ${exposed.join(", ")} into every new shell, the agents' included. Consort strips them from each agent's environment, but the agent's own shell gets them back; drop that export and keep the key in the reference above.`));
  const domains = await ask("Internal email domains the gate lets through (comma-separated)", { default: phi.internalEmailDomains.join(",") });
  const contact = await ask("Compliance contact named in the owner's alert (empty for none)", { default: phi.complianceContact });
  s = loadState(); s.phi = { ...s.phi, internalEmailDomains: domains.split(",").map((d) => d.trim()).filter(Boolean), ...(contact ? { complianceContact: contact } : {}) }; saveState(s);
}

export async function runSetup(): Promise<void> {
  const { ask, close, pause, resume } = prompter();
  try {
    console.log(banner("setup", [dim("Gets this machine ready to pick up tickets"), dim("and ship them unattended. Each step saves"), dim("as it goes; rerun setup any time.")]));
    const toolsFine = await checkTools();
    if (!toolsFine && !(await yes(ask, "Some tools are missing. Continue anyway?", false))) return;

    // ── sources ────────────────────────────────────────────────────────────────────────────
    console.log(head("2. Scanners: where tickets come from"));
    let s = loadState();
    for (const j of [...s.jobs]) {
      const scope = j.scope ? `${j.scope.kind} ${j.scope.id}` : j.listId ? `list ${j.listId}` : "issues";
      const f = [j.filters.tags?.length ? `tags ${j.filters.tags.join("/")}` : "", j.filters.statuses?.length ? `status ${j.filters.statuses.join("/")}` : ""].filter(Boolean).join(", ");
      if (!(await keep(ask, `scanner "${j.name}"`, `${j.source} ${scope} → ${j.repo} (${j.base})${f ? `; ${f}` : ""}; every ${j.everyMinutes} min`))) {
        s = loadState(); s.jobs = s.jobs.filter((x) => x.id !== j.id); saveState(s); console.log(`scanner "${j.name}" removed`);
      }
    }
    if (!s.jobs.length || await yes(ask, "Add another scanner? (a ClickUp worker, GitHub worker, Sentry ticket producer, or automatic PR reviews)", false)) {
      await addScanners(ask);
    }
    s = loadState();
    if (!s.branchPrefix || !(await keep(ask, "branch prefix", `${s.branchPrefix} (branches become ${s.branchPrefix}/<slug>-<id>)`))) {
      const prefix = await ask("Branch prefix for the branches it creates (e.g. bot → bot/<slug>-<id>)", { default: "bot" });
      s.branchPrefix = prefix.replace(/^\/+|\/+$/g, ""); saveState(s);
    }

    // ── project info resources ─────────────────────────────────────────────────────────
    console.log(head("3. Project info resources (optional)"));
    await resourceSteps(ask);

    // ── accounts ───────────────────────────────────────────────────────────────────────────
    console.log(head("4. AI accounts"));
    why("AI accounts", {
      for: "running the agents that build, test and review. A pool: when one account hits its usage limit the work moves to the next.",
      where: "a Claude or ChatGPT subscription login (runs the provider's login here, into ~/.consort-cli/logins/<account>, separate from Consort desktop and from your own `claude` or `codex`), or an API key from console.anthropic.com or platform.openai.com.",
      can: "read and change files in the task's worktree, run commands there, push branches, search the web. Nothing asks for permission at run time.",
      not: "see other tasks' worktrees or your personal login.",
    });
    s = loadState();
    for (const acc of [...s.accounts]) {
      const status = await accountStatus(acc);
      if (!(await keep(ask, `${acc.provider} account "${acc.name}"`, `${acc.auth === "key" ? `API key ${masked(acc.apiKey ?? "")}` : "subscription login"}, ${status}`, /signed in|logged in|key/i.test(status)))) {
        s = loadState(); s.accounts = s.accounts.filter((x) => x.id !== acc.id); saveState(s); console.log(`account "${acc.name}" removed`);
      }
    }
    while (s.jobs.length > 0 && (!s.accounts.length || await yes(ask, "Add an account?", !s.accounts.length))) {
      const provider = (await ask("Provider: claude or codex", { default: "claude" })).toLowerCase();
      if (provider !== "claude" && provider !== "codex") { console.log(bad("type claude or codex")); continue; }
      const name = await ask("A label for it (e.g. work, personal, billing)", { default: `${provider} ${s.accounts.filter((x) => x.provider === provider).length + 1}` });
      const useKey = await yes(ask, "Use an API key instead of a subscription login?", false);
      if (useKey) {
        const key = await ask(provider === "claude" ? "Anthropic API key" : "OpenAI API key", { secret: true });
        const works = provider === "claude" ? await testAnthropicKey(key) : await testOpenAiKey(key);
        if (!works) { console.log(bad("the provider rejected that key")); continue; }
        const acc = createAccount(loadState(), provider, name, key);
        console.log(ok(`${acc.name}: key works`));
      } else {
        const acc = createAccount(loadState(), provider, name);
        console.log(`Signing in ${acc.name}; the ${provider === "claude" ? "Claude Code" : "Codex"} login runs now in this terminal (it prints a URL to open if there is no browser here).`);
        try { await loginInteractive(acc); } catch (e) { console.log(bad(`login did not finish: ${(e as Error).message}`)); }
        const status = await accountStatus(acc);
        console.log(/signed in|logged in/i.test(status) ? ok(`${acc.name}: ${status}`) : bad(`${acc.name}: ${status}`));
      }
      s = loadState();
    }

    // ── slack ──────────────────────────────────────────────────────────────────────────────
    // ── PHI/PII guard ─────────────────────────────────────────────────────────────────
    console.log(head("5. PHI/PII guard"));
    await phiSteps(ask, { pause, resume });

    console.log(head("6. Slack, where it asks you things"));
    why("Slack bot token", {
      for: "the only way consort-cli talks to you: one DM thread per ticket with progress, the few questions it cannot decide, and the ready-to-merge ping. You answer in the thread.",
      where: "your team's shared Consort app if it has one (ask whoever set it up for the xoxb- token). Otherwise make one: api.slack.com/apps → Create New App → From a manifest → paste docs/slack-app-manifest.json → Install to Workspace → OAuth & Permissions → Bot User OAuth Token (starts xoxb-). A user token (xoxp-) or a webhook URL will not do.",
      needs: [
        "these Bot Token Scopes on that same page (Scopes → Bot Token Scopes → Add an OAuth Scope):",
        ...slackScopeLines(),
        "After adding one, click \"reinstall your app\" in the yellow banner at the top (or Install App in the left menu → Reinstall to Workspace → Allow), then copy the token again: the old token keeps the old scopes.",
      ],
      can: "post to the DM with you (or one channel you name) and read replies in those threads.",
      not: "read any other conversation, or post anywhere else.",
    });
    why("Your Slack member id", {
      for: "telling the bot who to DM, and whose replies count as answers (anyone else's in the thread are ignored).",
      where: "Slack → your profile → ⋯ (more) → Copy member ID. It starts with U or W. A pasted <@U…> mention or profile URL works too.",
      can: "nothing on its own; it is an address.",
    });
    s = loadState();
    let slackOk = false;
    if (s.slack) {
      const who = await new Slack(s.slack).test().catch(() => undefined);
      slackOk = await keep(ask, "Slack", `bot token ${masked(s.slack.botToken)} ${who ? ok(`works (bot "${who.bot}" in ${who.team})`) : bad("does not work any more")}, your member id ${s.slack.userId}`, !!who);
    }
    let scopeTrouble = false;
    while (!slackOk) {
      if (scopeTrouble) {
        console.log(`  ${dim("Reminder")}   the bot token needs these scopes; add the missing one, reinstall the app, and paste the new token:`);
        for (const l of slackScopeLines()) console.log(`             ${l}`);
        scopeTrouble = false;
      }
      const botToken = await ask("Bot User OAuth Token (xoxb-…)", { secret: true });
      if (!/^xoxb-/.test(botToken)) console.log(bad(`that is not a bot token (it should start with xoxb-${botToken.startsWith("xoxp-") ? "; xoxp- is a user token" : ""})`));
      const userId = slackUserIdFrom(await ask("Your Slack member id (U…)", { default: s.slack?.userId }));
      if (!userId) { console.log(bad("that does not look like a member id (U0123ABC)")); continue; }
      const slack = new Slack({ botToken, userId });
      try {
        const who = await slack.test();
        console.log(ok(`token works: bot "${who.bot}" in ${who.team}`));
        const channel = await slack.channel().catch((e) => { throw new Error(`${e.message} — the bot needs the im:write scope (then reinstall the app)`); });
        console.log(ok(`DM with you opened (im:write)`));
        const ts = await slack.post(`consort-cli setup on this machine can reach you. Questions about tickets will arrive in threads here.`).catch((e) => { throw new Error(`${e.message} — the bot needs the chat:write scope`); });
        console.log(ok(`message posted (chat:write)`));
        await slack.waitForReply(ts, ts, { pollMs: 1, timeoutMs: 1 }).then(() => undefined, () => undefined);
        const canRead = await (slack as any).api("conversations.replies", { channel, ts, limit: 1 }).then(() => true, (e: Error) => { console.log(bad(/missing_scope/.test(e.message) ? `${e.message} — the bot needs the im:history scope to read your replies` : `${e.message} — reading the thread back failed`)); return false; });
        if (canRead) console.log(ok(`replies readable (im:history)`));
        if (!(await yes(ask, "Did the message arrive in your Slack DMs?"))) { console.log(bad("check the app is installed to this workspace and the member id is yours")); continue; }
        if (!canRead) { console.log(bad("it can post but cannot read the thread back, so it would never hear you; fix the above and try again")); continue; }
        s = loadState(); s.slack = { botToken, userId, channel }; saveState(s);
        break;
      } catch (e) { console.log(bad(`Slack said: ${(e as Error).message}`)); scopeTrouble = /scope/i.test((e as Error).message); }
    }

    // ── permissions on the box ──────────────────────────────────────────────────────────────
    console.log(head("7. Permissions"));
    s = loadState();
    for (const job of s.jobs) {
      const probe = join(WORK_DIR, `.probe-${process.pid}`);
      try { mkdirSync(probe, { recursive: true }); (await import("node:fs")).rmSync(probe, { recursive: true }); console.log(ok(`can create worktrees under ${WORK_DIR}`)); } catch { console.log(bad(`cannot write ${WORK_DIR}`)); }
      if (job.source === "review") {
        // a review never pushes; it reads PRs and posts reviews with the gh login, and approves only after a Slack yes
        const who = await run("gh", ["api", "user", "--jq", ".login"], { cwd: job.repo, timeout: 30_000 }).then((r) => r.stdout.trim(), () => "");
        const prs = await run("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number"], { cwd: job.repo, timeout: 60_000 }).then((r) => JSON.parse(r.stdout).length as number, () => -1);
        console.log(prs >= 0 ? ok(`gh can read ${job.repo}'s PRs (${prs} open); reviews post as @${who || "?"}`) : bad(`gh cannot list PRs in ${job.repo}: run gh auth login`));
        if (who && job.reviewer && who.toLowerCase() !== job.reviewer.toLowerCase()) console.log(dim(`reviews are for @${job.reviewer} but post as @${who}; GitHub shows them from @${who}`));
        if (!s.slack) console.log(bad(`review scanner "${job.name}" will never approve: approval waits for your yes on Slack, and Slack is not set up`));
        continue;
      }
      const push = await run("git", ["push", "--dry-run", "origin", `HEAD:refs/heads/consort-cli-probe-${process.pid}`], { cwd: job.repo, timeout: 60_000 }).then(() => true, () => false);
      console.log(push ? ok(`can push branches to origin of ${job.repo}`) : bad(`cannot push to origin of ${job.repo}: check the deploy key or token`));
      if (job.source === "clickup" && s.clickupKey && (job.scope || job.listId)) {
        const where = job.scope ? `${job.scope.kind} ${job.scope.id}` : `list ${job.listId}`;
        const cnt = await clickupSource(s.clickupKey, job).scan().then((t) => t.length, () => -1);
        console.log(cnt >= 0 ? ok(`ClickUp ${where} readable (${cnt} open task${cnt === 1 ? "" : "s"}${job.filters?.tags?.length ? ` tagged ${job.filters.tags.join("/")}` : ""})`) : bad(`cannot read ClickUp ${where}`));
      }
    }

    s = loadState(); s.setupCompletedAt = Date.now(); saveState(s);
    console.log(head("Done"));
    console.log(`${s.accounts.length} account(s), ${s.jobs.length} scanner(s), ${s.resources?.length ?? 0} project info resource(s), Slack ${s.slack ? "on" : "off"}.\nStart it:   consort-cli run\nWatch it:   consort-cli view\nDry run:    consort-cli scanners scan <scanner id>`);
  } catch (e) {
    // ctrl-d or a closed pipe: what was saved stays saved; the flag is not set
    if (/readline was closed|closed/i.test(String((e as Error).message))) { console.log("\nSetup stopped before finishing; what you entered is saved. Run `consort-cli setup` again to continue."); return; }
    throw e;
  } finally { close(); }
}
