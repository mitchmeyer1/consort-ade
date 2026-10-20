import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { cliStatus } from "../main/cliRuntime";
import { accountStatus, loginInteractive, runtimeDeps } from "./agent";
import { Slack } from "./slack";
import { clickupSource } from "./sources";
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

const run = promisify(execFile);

import { chooseFrom, clickupListIdFrom, slackUserIdFrom } from "../shared/headless.ts";
export { chooseFrom, clickupListIdFrom, slackUserIdFrom };
export const setupDone = (s: Pick<CliState, "setupCompletedAt">) => !!s.setupCompletedAt;

type Ask = (q: string, opts?: { secret?: boolean; default?: string }) => Promise<string>;

function prompter(): { ask: Ask; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask: Ask = async (q, opts = {}) => {
    const label = `${mint("›")} ${q}${opts.default ? dim(` [${opts.default}]`) : ""}${mint(":")} `;
    if (opts.secret && process.stdin.isTTY) {
      // keystrokes are not echoed: readline writes the prompt, we swallow the input's echo
      process.stdout.write(label);
      const out = process.stdout as any;
      const orig = out.write.bind(out);
      let muted = true;
      out.write = (chunk: any, ...rest: any[]) => (muted ? true : orig(chunk, ...rest));
      try { const v = await rl.question(""); muted = false; orig("\n"); return v.trim() || (opts.default ?? ""); }
      finally { out.write = orig; }
    }
    const v = (await rl.question(label)).trim();
    return v || (opts.default ?? "");
  };
  return { ask, close: () => rl.close() };
}

const yes = async (ask: Ask, q: string, dflt = true) => /^y/i.test(await ask(`${q} (${dflt ? "Y/n" : "y/N"})`, { default: dflt ? "y" : "n" }));

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
async function describeList(key: string, listId: string): Promise<{ name: string; statuses: string[] } | undefined> {
  const res = await fetch(`https://api.clickup.com/api/v2/list/${encodeURIComponent(listId)}`, { headers: { Authorization: key }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
  if (!res?.ok) return undefined;
  const j = await res.json();
  return { name: j.name ?? listId, statuses: ((j.statuses ?? []) as any[]).map((s) => String(s.status)) };
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
    console.log(head("2. Where tickets come from"));
    let s = loadState();
    if (s.jobs.length) { console.log(`${s.jobs.length} job(s) already set up: ${s.jobs.map((j) => j.name).join(", ")}`); }
    if (!s.jobs.length || await yes(ask, "Add another source?", false)) {
      for (;;) {
        const kind = (await ask("Source: clickup or github", { default: "clickup" })).toLowerCase();
        if (kind !== "clickup" && kind !== "github") { console.log(bad("type clickup or github")); continue; }
        const job: Partial<Job> = { id: newId("job"), source: kind as Job["source"], filters: {}, everyMinutes: 15, maxParallel: 2, statuses: { ...DEFAULT_STATUSES }, enabled: true, createdAt: Date.now() };
        if (kind === "clickup") {
          s = loadState();
          let key = s.clickupKey;
          if (key) console.log(`A ClickUp key is saved${(await testClickupKey(key)) ? " and works" : " but does not work any more"}.`);
          while (!key || !(await testClickupKey(key))) {
            key = await ask("ClickUp API key (ClickUp → your avatar → Settings → Apps → API Token)", { secret: true });
            const who = await testClickupKey(key);
            console.log(who ? ok(`key works (${who})`) : bad("ClickUp rejected that key"));
            if (!who) key = undefined;
          }
          s.clickupKey = key; saveState(s);
          let list: { name: string; statuses: string[] } | undefined;
          while (!list) {
            const id = clickupListIdFrom(await ask("ClickUp list to watch (list id, or the list's URL)"));
            if (!id) { console.log(bad("that is not a list id or list URL")); continue; }
            list = await describeList(key, id);
            if (!list) { console.log(bad("ClickUp has no list with that id for this key")); continue; }
            job.listId = id;
            console.log(ok(`list "${list.name}" with statuses: ${list.statuses.join(" · ")}`));
          }
          job.name = await ask("A name for this job", { default: list.name });
          const tags = await ask("Only tasks with one of these tags (comma-separated; empty for any)", { default: "ai-handle" });
          job.filters!.tags = tags.split(",").map((t) => t.trim()).filter(Boolean);
          console.log("Statuses the job picks tasks up from:"); list.statuses.forEach((st, i) => console.log(`  ${i + 1}. ${st}`));
          job.filters!.statuses = chooseFrom(await ask("Pick by number or name (comma-separated; empty for any)", { default: "1" }), list.statuses);
          job.statuses = {
            progress: chooseFrom(await ask("Status to set while working", { default: list.statuses.find((x) => /progress/i.test(x)) ?? DEFAULT_STATUSES.progress }), list.statuses)[0] ?? DEFAULT_STATUSES.progress,
            review: chooseFrom(await ask("Status to set when the PR is up", { default: list.statuses.find((x) => /review/i.test(x)) ?? DEFAULT_STATUSES.review }), list.statuses)[0] ?? DEFAULT_STATUSES.review,
            done: chooseFrom(await ask("Status to set when the PR is merged", { default: list.statuses.find((x) => /complete|done|closed/i.test(x)) ?? DEFAULT_STATUSES.done }), list.statuses)[0] ?? DEFAULT_STATUSES.done,
          };
        } else {
          job.name = await ask("A name for this job", { default: "issues" });
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
        job.everyMinutes = Number(await ask("Scan every N minutes", { default: "15" })) || 15;
        job.maxParallel = Number(await ask("Tickets worked on at once for this job", { default: "2" })) || 2;
        s = loadState(); s.jobs.push(job as Job); saveState(s);
        console.log(ok(`job "${job.name}" saved`));
        if (!(await yes(ask, "Add another source?", false))) break;
      }
    }
    s = loadState();
    const prefix = await ask("Branch prefix for the branches it creates (e.g. bot → bot/<slug>-<id>)", { default: s.branchPrefix ?? "bot" });
    s.branchPrefix = prefix.replace(/^\/+|\/+$/g, ""); saveState(s);

    // ── accounts ───────────────────────────────────────────────────────────────────────────
    console.log(head("3. AI accounts"));
    console.log("Each login lives under ~/.consort-cli/logins/<account>, separate from Consort desktop and from your own `claude` or `codex` login. Add every account you want in the pool: when one hits its usage limit the work moves to the next.");
    s = loadState();
    for (const acc of s.accounts) console.log(`  ${acc.provider.padEnd(6)} ${acc.name.padEnd(20)} ${await accountStatus(acc)}`);
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
    console.log("Make a Slack app (api.slack.com/apps → Create New App → From scratch), add a bot with scopes chat:write, im:write and im:history, install it to the workspace, and copy the Bot User OAuth Token (xoxb-…). Your member id is under your profile → ⋯ → Copy member ID.");
    s = loadState();
    if (s.slack) console.log(`Slack is set for user ${s.slack.userId}.`);
    while (!s.slack || await yes(ask, "Change the Slack settings?", false)) {
      const botToken = await ask("Bot token", { secret: true, default: s.slack?.botToken });
      const userId = slackUserIdFrom(await ask("Your Slack member id (U…)", { default: s.slack?.userId }));
      if (!userId) { console.log(bad("that does not look like a member id (U0123ABC)")); continue; }
      const slack = new Slack({ botToken, userId });
      try {
        const who = await slack.test();
        const channel = await slack.channel();
        await slack.post(`consort-cli setup on this machine can reach you. Questions about tickets will arrive in threads here.`);
        console.log(ok(`bot ${who.bot} in ${who.team} posted a DM`));
        if (!(await yes(ask, "Did the message arrive in your Slack DMs?"))) { console.log(bad("check the bot has im:write and is installed to the workspace")); continue; }
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
      if (job.source === "clickup" && s.clickupKey && job.listId) {
        const cnt = await clickupSource(s.clickupKey, job).scan().then((t) => t.length, () => -1);
        console.log(cnt >= 0 ? ok(`ClickUp list ${job.listId} readable (${cnt} open task${cnt === 1 ? "" : "s"})`) : bad(`cannot read ClickUp list ${job.listId}`));
      }
    }

    s = loadState(); s.setupCompletedAt = Date.now(); saveState(s);
    console.log(head("Done"));
    console.log(`${s.accounts.length} account(s), ${s.jobs.length} job(s), Slack ${s.slack ? "on" : "off"}.\nStart it:   consort-cli run\nWatch it:   consort-cli view\nDry run:    consort-cli jobs scan <job id>`);
  } catch (e) {
    // ctrl-d or a closed pipe: what was saved stays saved; the flag is not set
    if (/readline was closed|closed/i.test(String((e as Error).message))) { console.log("\nSetup stopped before finishing; what you entered is saved. Run `consort-cli setup` again to continue."); return; }
    throw e;
  } finally { close(); }
}
