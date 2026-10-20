import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { cliStatus } from "../main/cliRuntime";
import { accountStatus, loginInteractive, runtimeDeps } from "./agent";
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
import { findBrowser } from "./evidence";

const run = promisify(execFile);

import { chooseFrom, clickupListIdFrom, clickupScopeFrom, masked, slackUserIdFrom, type ClickupScope } from "../shared/headless.ts";
export { chooseFrom, clickupListIdFrom, slackUserIdFrom };
/** the default name for a new scanner: Consort Watcher, numbered once there is more than one */
export const scannerName = (s: Pick<CliState, "jobs">) => (s.jobs.length ? `Consort Watcher ${s.jobs.length + 1}` : "Consort Watcher");
export const setupDone = (s: Pick<CliState, "setupCompletedAt">) => !!s.setupCompletedAt;

type Ask = (q: string, opts?: { secret?: boolean; default?: string }) => Promise<string>;

function prompter(): { ask: Ask; close: () => void } {
  // lines are queued as they arrive, so a piped or pasted answer is never lost between questions
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  const queue: string[] = [];
  const waiters: ((s: string) => void)[] = [];
  let closed = false;
  rl.on("line", (l) => { const w = waiters.shift(); if (w) w(l); else queue.push(l); });
  rl.on("close", () => { closed = true; for (const w of waiters.splice(0)) w("\u0004"); });
  const next = () => (queue.length ? Promise.resolve(queue.shift()!) : closed ? Promise.resolve("\u0004") : new Promise<string>((r) => waiters.push(r)));
  const ask: Ask = async (q, opts = {}) => {
    const label = `${mint("›")} ${q}${opts.default ? dim(` [${opts.default}]`) : ""}${mint(":")} `;
    process.stdout.write(label);
    const out = process.stdout as any;
    const orig = out.write.bind(out);
    if (opts.secret && process.stdin.isTTY) out.write = () => true; // keystrokes are not echoed
    try {
      const v = await next();
      if (v === "\u0004") throw new Error("readline was closed");
      return v.trim() || (opts.default ?? "");
    } finally { out.write = orig; if (opts.secret && process.stdin.isTTY) orig("\n"); }
  };
  return { ask, close: () => rl.close() };
}

const yes = async (ask: Ask, q: string, dflt = true) => /^y/i.test(await ask(`${q} (${dflt ? "Y/n" : "y/N"})`, { default: dflt ? "y" : "n" }));
/** a step that already has a value: show it, and "y" (or Enter) keeps it; "n" asks again */
const keep = async (ask: Ask, what: string, value: string, dflt = true) => { console.log(`${dim("Saved")} ${what}: ${value}`); return yes(ask, "Keep it?", dflt); };

/** before each credential: what it is for, where to get it, and what it lets consort-cli do */
const why = (title: string, lines: { for: string; where: string; can: string; not?: string }) => {
  console.log(`\n${mint(title)}`);
  console.log(`  ${dim("Used for")}   ${lines.for}`);
  console.log(`  ${dim("Where")}      ${lines.where}`);
  console.log(`  ${dim("It can")}     ${lines.can}`);
  if (lines.not) console.log(`  ${dim("It cannot")}  ${lines.not}`);
};

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
  console.log(browser ? ok(`headless Chrome for evidence screenshots: ${browser}`) : `${dim("–")} no Chrome or Chromium found: evidence will be text only (install google-chrome or chromium, or set CONSORT_CHROME)`);
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

async function repoChecks(ask: Ask): Promise<{ repo: string; base: string } | undefined> {
  for (;;) {
    why("Repository checkout", {
      for: "the base every feature branch is cut from; worktrees are made beside it, never inside your checkout.",
      where: "an existing `git clone` on this machine, on its base branch, with a remote named origin that `gh` can see.",
      can: "fetch, create branches, push them and open PRs through your `gh` login.",
      not: "merge; merging stays yours.",
    });
    const repo = resolve(await ask("Path of the repository checkout on this machine"));
    if (!existsSync(join(repo, ".git"))) { console.log(bad(`${repo} has no .git; clone it first`)); if (!(await yes(ask, "Try another path?"))) return undefined; continue; }
    const current = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo }).catch(() => ({ stdout: "" }))).stdout.trim();
    const base = await ask("Base branch features are cut from and PRs target", { default: current && current !== "HEAD" ? current : "main" });
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

export async function runSetup(): Promise<void> {
  const { ask, close } = prompter();
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
    if (!s.jobs.length || await yes(ask, "Add another source?", false)) {
      for (;;) {
        const kind = (await ask("Source: clickup or github", { default: "clickup" })).toLowerCase();
        if (kind !== "clickup" && kind !== "github") { console.log(bad("type clickup or github")); continue; }
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
        if (!repo) { console.log("Skipping this source."); if (await yes(ask, "Add a different source?", false)) continue; break; }
        job.repo = repo.repo; job.base = repo.base;
        if (kind === "github") {
          const n = await run("gh", ["issue", "list", "--state", "open", "--limit", "5", "--json", "number"], { cwd: job.repo, timeout: 30_000 }).then((r) => JSON.parse(r.stdout).length, () => -1);
          console.log(n >= 0 ? ok(`gh can list issues here (${n} open among the first five)`) : bad("gh cannot list issues in this repo"));
        }
        job.everyMinutes = Number(await ask("Scan every N minutes", { default: "1" })) || 1;
        job.maxParallel = Number(await ask("Tickets this scanner works on at once", { default: "2" })) || 2;
        s = loadState(); s.jobs.push(job as Job); saveState(s);
        console.log(ok(`scanner "${job.name}" saved`));
        if (!(await yes(ask, "Add another source?", false))) break;
      }
    }
    s = loadState();
    if (!s.branchPrefix || !(await keep(ask, "branch prefix", `${s.branchPrefix} (branches become ${s.branchPrefix}/<slug>-<id>)`))) {
      const prefix = await ask("Branch prefix for the branches it creates (e.g. bot → bot/<slug>-<id>)", { default: "bot" });
      s.branchPrefix = prefix.replace(/^\/+|\/+$/g, ""); saveState(s);
    }

    // ── accounts ───────────────────────────────────────────────────────────────────────────
    console.log(head("3. AI accounts"));
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
    while (!s.accounts.length || await yes(ask, "Add an account?", !s.accounts.length)) {
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
    console.log(head("4. Slack, where it asks you things"));
    why("Slack bot token", {
      for: "the only way consort-cli talks to you: one DM thread per ticket with progress, the few questions it cannot decide, and the ready-to-merge ping. You answer in the thread.",
      where: "a Slack app with a bot user, yours or an existing one: api.slack.com/apps → your app → OAuth & Permissions → Bot User OAuth Token (starts xoxb-). A user token (xoxp-) or a webhook URL will not do. Scopes: chat:write, im:write, im:history (channels:history if you point it at a channel). Add a missing scope, reinstall the app, copy the token again.",
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
    while (!slackOk) {
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
        const canRead = await (slack as any).api("conversations.replies", { channel, ts, limit: 1 }).then(() => true, (e: Error) => { console.log(bad(`${e.message} — the bot needs the im:history scope to read your replies`)); return false; });
        if (canRead) console.log(ok(`replies readable (im:history)`));
        if (!(await yes(ask, "Did the message arrive in your Slack DMs?"))) { console.log(bad("check the app is installed to this workspace and the member id is yours")); continue; }
        if (!canRead) { console.log(bad("without im:history it can post but never hear you; add the scope and rerun")); continue; }
        s = loadState(); s.slack = { botToken, userId, channel }; saveState(s);
        break;
      } catch (e) { console.log(bad(`Slack said: ${(e as Error).message}`)); }
    }

    // ── permissions on the box ──────────────────────────────────────────────────────────────
    console.log(head("5. Permissions"));
    s = loadState();
    for (const job of s.jobs) {
      const probe = join(WORK_DIR, `.probe-${process.pid}`);
      try { mkdirSync(probe, { recursive: true }); (await import("node:fs")).rmSync(probe, { recursive: true }); console.log(ok(`can create worktrees under ${WORK_DIR}`)); } catch { console.log(bad(`cannot write ${WORK_DIR}`)); }
      const push = await run("git", ["push", "--dry-run", "origin", `HEAD:refs/heads/consort-cli-probe-${process.pid}`], { cwd: job.repo, timeout: 60_000 }).then(() => true, () => false);
      console.log(push ? ok(`can push branches to origin of ${job.repo}`) : bad(`cannot push to origin of ${job.repo}: check the deploy key or token`));
      if (job.source === "clickup" && s.clickupKey && (job.scope || job.listId)) {
        const where = job.scope ? `${job.scope.kind} ${job.scope.id}` : `list ${job.listId}`;
        const cnt = await clickupSource(s.clickupKey, job).scan().then((t) => t.length, () => -1);
        console.log(cnt >= 0 ? ok(`ClickUp ${where} readable (${cnt} open task${cnt === 1 ? "" : "s"})`) : bad(`cannot read ClickUp ${where}`));
      }
    }

    s = loadState(); s.setupCompletedAt = Date.now(); saveState(s);
    console.log(head("Done"));
    console.log(`${s.accounts.length} account(s), ${s.jobs.length} scanner(s), Slack ${s.slack ? "on" : "off"}.\nStart it:   consort-cli run\nWatch it:   consort-cli view\nDry run:    consort-cli scanners scan <scanner id>`);
  } catch (e) {
    // ctrl-d or a closed pipe: what was saved stays saved; the flag is not set
    if (/readline was closed|closed/i.test(String((e as Error).message))) { console.log("\nSetup stopped before finishing; what you entered is saved. Run `consort-cli setup` again to continue."); return; }
    throw e;
  } finally { close(); }
}
