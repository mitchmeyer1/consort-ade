#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claimedByOther, matchesFilters, type ReviewPick, type SourceFilters } from "../shared/headless.ts";
import { cliStatus, updateCli } from "../main/cliRuntime";
import { accountStatus, loginInteractive, runtimeDeps } from "./agent";
import { newTask, workTask } from "./pipeline";
import { Slack } from "./slack";
import { sourceFor } from "./sources";
import { renderView, viewLoop } from "./view";
import { createAccount, runSetup, setupDone } from "./setup";
import { applyBundle, buildBundle } from "./transfer";
import { cleanupEnvironment } from "./environment";
import { banner, cream, dim, mint, ok, bad } from "./theme";
import { FINISHED } from "../shared/headless.ts";
import { DEFAULT_STATUSES, host, loadState, LOG_DIR, newId, saveState, type Job, type Task } from "./state";

/**
 * consort-cli: Consort's pipeline without the window. Add AI accounts, point it at Slack, add a
 * scanner that watches a ClickUp list, folder or space or a repo's issues, and `consort-cli run` keeps a daemon
 * going: every N minutes it scans, claims what matches, and hands each ticket to a worker
 * process that ships it (src/cli/pipeline.ts) and asks the owner over Slack when it must.
 */

type Args = { _: string[]; [k: string]: string | string[] | boolean };
function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      const v = inline ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true");
      const prev = out[k];
      out[k] = prev === undefined ? (v === "true" ? true : v) : Array.isArray(prev) ? [...prev, v] : [String(prev), v];
    } else out._.push(a);
  }
  return out;
}
const str = (a: Args, k: string): string | undefined => { const v = a[k]; return typeof v === "string" ? v : Array.isArray(v) ? v[v.length - 1] : undefined; };
const list = (a: Args, k: string): string[] => { const v = a[k]; const items = typeof v === "string" ? [v] : Array.isArray(v) ? v : []; return items.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean); };
const need = (a: Args, k: string): string => { const v = str(a, k); if (!v) fail(`--${k} is required`); return v!; };
const fail = (msg: string): never => { console.error(`consort-cli: ${msg}`); process.exit(2); };

const HELP = `${banner("Consort's ship pipeline, headless", [dim("Tickets in, reviewed PRs out, questions on Slack.")])}

  ${mint("setup")}                                                                   the walk-through: tools, sources, accounts, Slack, permissions
  accounts add --provider claude|codex --name <label> [--api-key <key>]   add an AI account (a CLI login unless --api-key)
  accounts list | accounts remove <id>
  slack set --bot-token xoxb-… --user <U…> [--channel <C…>]            where questions and progress go (DM by default)
  slack test
  clickup set-key <key>
  prefix set <branch-prefix>                                             e.g. "bot" → bot/<slug>-<id>
  scanners add --name <n> --source clickup --list|--folder|--space <id> --repo <path> --base main [--tag ai-handle] [--status "to do"]
           [--name-includes <s>] [--name-excludes <s>] [--assignee <who>] [--every 1] [--max-parallel 2]
           [--status-progress "in progress"] [--status-review "in review"] [--status-done complete]
           [--review-models claude:claude-fable-5-1,codex:gpt-6-astra,claude:claude-opus-5]
  scanners add --name <n> --source github --repo <path> --base main [--tag ai-handle] …
  scanners list | scanners remove <id> | scanners enable|disable <id> | scanners scan <id>   (scan: dry run)
                                                                          a scanner watches one place for tickets and hands each match to a worker agent
  run                                                                     the daemon: scan, claim, dispatch, watch
  view [--once] [--width N]                                              live table of agents, what they are doing, and progress
  work <taskId>                                                           one worker (the daemon runs this)
  tasks list | tasks release <taskId> | tasks logs <taskId>
  cli status | cli update                                                 the Claude Code and Codex binaries
  status
  export [--out <file>] [--scanner <id or name>]                          one file with the tokens, accounts and scanners this box runs
  import <file> [--repo-dir <dir>] [--replace]                            set up this box from that file; clones repos it lacks
  accounts login <id>                                                     sign an account in again (after an import without credentials)`;

async function main(argv: string[]) {
  const a = parseArgs(argv);
  const [cmd, sub, ...rest] = a._;
  const s = loadState();
  const key = cmd === "import" ? "import" : `${cmd === "jobs" ? "scanners" : cmd ?? "help"} ${sub ?? ""}`.trim(); // "jobs" was the first name for scanners; import <file> takes a path, not a subcommand
  // everything that touches tickets, accounts or agents waits for the walk-through
  const open = ["help", "--help", "-h", "setup", "status", "cli status", "cli update", "import"];
  if (!open.includes(key) && !setupDone(s)) fail("not set up yet. Run `consort-cli setup` first; it checks the tools, adds your issue sources, AI accounts and Slack, and tests each one.");
  switch (key) {
    case "help": case "--help": case "-h": console.log(HELP.replace(/^(  )([a-z]+(?: [a-z-]+)?)/gm, (_m, sp, cmd) => `${sp}${mint(cmd)}`)); return;
    case "setup": await runSetup(); return;

    case "accounts add": {
      const provider = need(a, "provider") as "claude" | "codex";
      if (provider !== "claude" && provider !== "codex") fail("--provider must be claude or codex");
      const apiKey = str(a, "api-key");
      const account = createAccount(s, provider, str(a, "name"), apiKey);
      console.log(`Added ${account.name} (${account.id}).`);
      if (!apiKey) { console.log(`Signing in; this runs the ${provider === "claude" ? "Claude Code" : "Codex"} login in your terminal.`); await loginInteractive(account); }
      console.log(await accountStatus(account));
      return;
    }
    case "accounts list": {
      if (!s.accounts.length) { console.log("No accounts. Add one with: consort-cli accounts add --provider claude --name work"); return; }
      for (const acc of s.accounts) console.log(`${acc.id}  ${acc.provider.padEnd(6)}  ${acc.name.padEnd(20)}  ${await accountStatus(acc)}${acc.blockedUntil && acc.blockedUntil > Date.now() ? `  · blocked until ${new Date(acc.blockedUntil).toLocaleTimeString()}` : ""}`);
      return;
    }
    case "accounts login": {
      const acc = s.accounts.find((x) => x.id === rest[0] || x.name === rest[0]) ?? fail("no such account");
      if (acc!.auth !== "login") fail(`${acc!.name} uses an API key; nothing to sign in`);
      console.log(`Signing in ${acc!.name}; this runs the ${acc!.provider === "claude" ? "Claude Code" : "Codex"} login in your terminal.`);
      await loginInteractive(acc!); console.log(await accountStatus(acc!)); return;
    }
    case "export": case "agent-dump": {
      const only = list(a, "scanner");
      const b = await buildBundle(s, { only: only.length ? only : undefined });
      const out = resolve(str(a, "out") ?? `consort-cli-${host()}-${new Date().toISOString().slice(0, 10)}.json`);
      writeFileSync(out, JSON.stringify(b, null, 2), { mode: 0o600 });
      const noCred = b.accounts.filter((x) => x.auth === "login" && !x.credentials).map((x) => x.name);
      console.log(`Wrote ${out} (mode 600): ${b.scanners.length} scanner(s), ${b.accounts.length} account(s), ClickUp ${b.clickupKey ? "token" : "none"}, Slack ${b.slack ? "set" : "none"}.`);
      console.log(`On the other machine: consort-cli import ${basename(out)}`);
      if (noCred.length) console.log(`${noCred.join(", ")}: login kept in this machine's keychain, so sign in there with: consort-cli accounts login <id>`);
      console.log("It holds secrets; move it over a private channel and delete it afterwards.");
      return;
    }
    case "import": {
      const file = sub ?? fail("file required");
      const b = JSON.parse(readFileSync(resolve(file!), "utf8"));
      const r = await applyBundle(s, b, { repoDir: str(a, "repo-dir"), replace: !!a.replace, create: createAccount });
      saveState(s);
      if (r.cloned.length) console.log(`Cloned: ${r.cloned.join("; ")}`);
      console.log(`Added: ${r.added.join(", ") || "nothing"}`);
      if (r.kept.length) console.log(`Already here, kept: ${r.kept.join(", ")}${a.replace ? "" : " (--replace overrides settings)"}`);
      if (r.needLogin.length) console.log(`Sign in: ${r.needLogin.map((id) => `consort-cli accounts login ${id}`).join("; ")}`);
      console.log("Ready. Start it: consort-cli run");
      return;
    }
    case "accounts remove": { const id = rest[0] ?? fail("account id required"); s.accounts = s.accounts.filter((x) => x.id !== id); saveState(s); console.log("Removed."); return; }

    case "slack set": { s.slack = { botToken: need(a, "bot-token"), userId: need(a, "user"), channel: str(a, "channel") }; saveState(s); console.log("Slack saved. Test it with: consort-cli slack test"); return; }
    case "slack test": {
      if (!s.slack) fail("no Slack configured");
      const slack = new Slack(s.slack!);
      const who = await slack.test();
      const ts = await slack.post(`consort-cli on ${host()} can reach you. Replies in threads here answer its questions.`);
      s.slack = { ...s.slack!, channel: await slack.channel() }; saveState(s);
      console.log(`OK: bot ${who.bot} in ${who.team}; posted ${ts} to ${s.slack.channel}`);
      return;
    }
    case "clickup set-key": { s.clickupKey = rest[0] ?? fail("key required"); saveState(s); console.log("ClickUp key saved."); return; }
    case "prefix set": { s.branchPrefix = (rest[0] ?? "").replace(/^\/+|\/+$/g, ""); saveState(s); console.log(`Branch prefix: ${s.branchPrefix || "(none)"}`); return; }

    case "scanners add": {
      const source = need(a, "source") as Job["source"];
      if (source !== "clickup" && source !== "github") fail("--source must be clickup or github");
      const repo = resolve(need(a, "repo"));
      if (!existsSync(join(repo, ".git"))) fail(`${repo} is not a git checkout`);
      const filters: SourceFilters = { tags: list(a, "tag"), statuses: list(a, "status"), nameIncludes: list(a, "name-includes"), nameExcludes: list(a, "name-excludes"), assignees: list(a, "assignee") };
      const reviewModels: ReviewPick[] = list(a, "review-models").map((m) => { const [provider, model] = m.split(":"); if ((provider !== "claude" && provider !== "codex") || !model) fail(`bad --review-models entry: ${m}`); return { provider: provider as ReviewPick["provider"], model }; });
      const job: Job = {
        id: newId("job"), name: str(a, "name") ?? `${source} ${s.jobs.length + 1}`, source, repo, base: str(a, "base") ?? "main",
        listId: str(a, "list"), ...(str(a, "space") ? { scope: { kind: "space" as const, id: str(a, "space")! } } : str(a, "folder") ? { scope: { kind: "folder" as const, id: str(a, "folder")! } } : str(a, "list") ? { scope: { kind: "list" as const, id: str(a, "list")! } } : {}), filters, everyMinutes: Number(str(a, "every") ?? 1) || 1, maxParallel: Number(str(a, "max-parallel") ?? 2) || 2,
        statuses: { progress: str(a, "status-progress") ?? DEFAULT_STATUSES.progress, review: str(a, "status-review") ?? DEFAULT_STATUSES.review, done: str(a, "status-done") ?? DEFAULT_STATUSES.done },
        ...(reviewModels.length ? { reviewModels } : {}), enabled: true, createdAt: Date.now(),
      };
      if (source === "clickup" && !job.scope) fail("--list, --folder or --space <clickup id> is required for a clickup scanner");
      s.jobs.push(job); saveState(s);
      console.log(`Added scanner ${job.name} (${job.id}): ${source}${job.scope ? ` ${job.scope.kind} ${job.scope.id}` : ""} every ${job.everyMinutes} min → ${repo} on ${job.base}`);
      return;
    }
    case "scanners list": { for (const j of s.jobs) console.log(`${j.id}  ${j.enabled ? "on " : "off"}  ${j.name.padEnd(20)}  ${j.source}${j.scope ? ` ${j.scope.kind} ${j.scope.id}` : j.listId ? ` list ${j.listId}` : ""}  every ${j.everyMinutes}m  ${j.repo} (${j.base})  filters ${JSON.stringify(j.filters)}  last scan ${j.lastScanAt ? new Date(j.lastScanAt).toLocaleString() : "never"}`); if (!s.jobs.length) console.log("No scanners."); return; }
    case "scanners remove": { s.jobs = s.jobs.filter((j) => j.id !== rest[0]); saveState(s); console.log("Removed."); return; }
    case "scanners enable": case "scanners disable": { const j = s.jobs.find((x) => x.id === rest[0]) ?? fail("no such scanner"); j!.enabled = sub === "enable"; saveState(s); console.log(`${j!.name}: ${j!.enabled ? "on" : "off"}`); return; }
    case "scanners scan": {
      const j = s.jobs.find((x) => x.id === rest[0]) ?? fail("no such scanner");
      const tickets = await sourceFor(j!, s.clickupKey).scan();
      const taken = new Set(s.tasks.map((t) => t.ticket.id));
      for (const t of tickets) console.log(`${matchesFilters(t, j!.filters) ? (taken.has(t.id) ? "taken " : "MATCH ") : "skip  "} ${t.id}  ${t.status ?? ""}  [${t.tags.join(", ")}]  ${t.title}`);
      return;
    }

    case "run": return daemon();
    case "view": { if (a.once) { console.log(renderView(Date.now(), Number(str(a, "width") ?? 0) || undefined)); return; } return viewLoop(); }
    case "accounts unblock": { const acc = s.accounts.find((x) => x.id === rest[0]) ?? fail("no such account"); acc!.blockedUntil = undefined; acc!.blockedWhy = undefined; saveState(s); console.log(`${acc!.name} unblocked.`); return; }
    case "work": { const id = sub ?? fail("task id required"); await workTask(id!); return; }

    case "tasks list": { for (const t of s.tasks) console.log(`${t.id}  ${t.status.padEnd(10)}  ${t.ticket.id.padEnd(12)}  ${t.feature.stage.padEnd(14)}  ${t.branch}  ${t.note ?? ""}`); if (!s.tasks.length) console.log("No tasks."); return; }
    case "tasks release": {
      const t = s.tasks.find((x) => x.id === sub) ?? fail("no such task");
      if (t!.pid) { try { process.kill(t!.pid); } catch {} }
      t!.status = "released"; t!.pid = undefined; t!.finishedAt = Date.now(); saveState(s);
      if (t!.runCode) { const r = await cleanupEnvironment(t!.runCode); console.log(`Removed ${r.containers} container(s), ${r.networks} network(s), ${r.volumes} volume(s) of ${t!.runCode}.`); }
      console.log(`Released ${t!.ticket.id}; the worktree ${t!.worktree} is left in place.`); return;
    }
    case "tasks logs": { const f = join(LOG_DIR, `${sub}.log`); console.log(existsSync(f) ? (await import("node:fs")).readFileSync(f, "utf8") : `no log at ${f}`); return; }

    case "cli status": { for (const p of ["claude", "codex"] as const) { const st = await cliStatus(p, runtimeDeps); console.log(`${p}: ${st.version ?? "not found"} (${st.source})${st.note ? ` · ${st.note}` : ""}`); } return; }
    case "cli update": { for (const p of ["claude", "codex"] as const) { const changed = await updateCli(p, undefined, runtimeDeps).catch((e) => { console.log(`${p}: ${e.message}`); return false; }); console.log(`${p}: ${changed ? "updated" : "unchanged"}`); } return; }

    case "status": {
      console.log(`${cream("Consort")} ${mint("consort-cli")} ${dim("on")} ${host()}`);
      console.log(setupDone(s) ? ok(`set up ${new Date(s.setupCompletedAt!).toLocaleDateString()}`) : bad("not set up: run consort-cli setup"));
      console.log(`  ${s.accounts.length} account(s) · slack ${s.slack ? mint("set") : dim("not set")} · clickup key ${s.clickupKey ? mint("set") : dim("not set")} · ${s.jobs.filter((j) => j.enabled).length}/${s.jobs.length} scanner(s) on`);
      for (const t of s.tasks.filter((t) => !["done", "released"].includes(t.status))) console.log(`  ${t.status.padEnd(10)} ${t.ticket.id} ${t.feature.stage}${t.note ? ` · ${t.note}` : ""}${t.pid && alive(t.pid) ? ` (pid ${t.pid})` : ""}`);
      return;
    }
    default: fail(`unknown command "${a._.join(" ")}". Try: consort-cli help`);
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** the daemon: run due scanners, claim matches, start a worker per task, restart workers that died */
async function daemon() {
  const self = fileURLToPath(import.meta.url);
  mkdirSync(LOG_DIR, { recursive: true });
  console.log(banner("daemon", [dim(`on ${host()}`), dim(`logs in ${LOG_DIR}`), dim("ctrl-c to stop")]));
  const spawnWorker = (t: Task) => {
    const out = openSync(join(LOG_DIR, `${t.id}.log`), "a");
    const child = spawn(process.execPath, [self, "work", t.id], { stdio: ["ignore", out, out], env: process.env });
    const s = loadState(); const task = s.tasks.find((x) => x.id === t.id); if (task) { task.pid = child.pid; saveState(s); }
    console.log(`${new Date().toISOString()} worker ${child.pid} → ${t.ticket.id} (${t.id})`);
    child.on("exit", (code) => {
      const s2 = loadState(); const task2 = s2.tasks.find((x) => x.id === t.id);
      if (task2 && task2.pid === child.pid) { task2.pid = undefined; if (code && !["ready", "done", "released"].includes(task2.status)) { task2.status = "failed"; task2.note = `worker exited ${code}; see tasks logs ${t.id}`; } saveState(s2); }
      console.log(`${new Date().toISOString()} worker ${child.pid} for ${t.ticket.id} exited ${code}`);
    });
  };
  for (;;) {
    const s = loadState();
    // finished tasks fall out of the state file after a week; the dashboard stops showing them after two hours
    const keep = s.tasks.filter((t) => !FINISHED.includes(t.status) || Date.now() - (t.finishedAt ?? t.updatedAt) < 7 * 24 * 3_600_000);
    if (keep.length !== s.tasks.length) { s.tasks = keep; saveState(s); }
    // workers that should be running but are not: the daemon restarted, or the box did
    for (const t of s.tasks) if (["working", "waiting", "monitoring"].includes(t.status) && !(t.pid && alive(t.pid))) spawnWorker(t);
    for (const job of s.jobs.filter((j) => j.enabled)) {
      const due = !job.lastScanAt || Date.now() - job.lastScanAt >= job.everyMinutes * 60_000;
      if (!due) continue;
      try {
        const source = sourceFor(job, s.clickupKey);
        const tickets = await source.scan();
        const live = loadState();
        const running = live.tasks.filter((t) => t.jobId === job.id && ["working", "waiting", "monitoring"].includes(t.status)).length;
        let slots = Math.max(0, job.maxParallel - running);
        const taken = new Set(live.tasks.filter((t) => t.status !== "released").map((t) => t.ticket.id));
        for (const t of tickets) {
          if (slots <= 0) break;
          if (taken.has(t.id) || !matchesFilters(t, job.filters)) continue;
          const comments = await source.comments(t.id).catch(() => []);
          if (claimedByOther(comments, host(), Date.now())) { console.log(`${t.id} claimed elsewhere; skipping`); continue; }
          await source.claim(t.id, host(), Date.now());
          const ticket = await source.ticket(t.id);
          const fresh = loadState();
          const task: Task = { id: newId("task"), ...newTask(job, ticket, fresh.branchPrefix, Date.now()) };
          fresh.tasks.push(task); saveState(fresh);
          console.log(`${new Date().toISOString()} claimed ${t.id} "${t.title}" → ${task.branch}`);
          spawnWorker(task);
          slots--;
        }
        const after = loadState(); const j = after.jobs.find((x) => x.id === job.id); if (j) { j.lastScanAt = Date.now(); saveState(after); }
      } catch (e) { console.error(`${new Date().toISOString()} scanner ${job.name} failed: ${(e as Error).message}`); const after = loadState(); const j = after.jobs.find((x) => x.id === job.id); if (j) { j.lastScanAt = Date.now(); saveState(after); } }
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

main(process.argv.slice(2)).catch((e) => { console.error(`consort-cli: ${(e as Error).message}`); process.exit(1); });
