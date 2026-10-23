#!/usr/bin/env node
import { canClaimSentryTicket, sentryWorkerJob } from "./sentryCapacity";
import { availableTaskSlots } from "./capacity";
import { EFFORT_LEVELS, isEffortLevel } from "../shared/cliTurnPolicy.ts";
import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claimedByOther, claimHeld, claimOf, matchesFilters, type ReviewPick, type SourceFilters } from "../shared/headless.ts";
import { cliStatus, updateCli } from "../main/cliRuntime";
import { accountStatus, loginInteractive, packageRoot, runtimeDeps, stopAgents } from "./agent";
import { newTask, workTask } from "./pipeline";
import { flushTaskNotifications, notifyTask, runTaskUntilFinished } from "./lifecycle";
import { statusEvent } from "./statusLog";
import { scanSentry, validateSentryConfig } from "./sentry";
import { Slack } from "./slack";
import { canStartWorker, handleWorkerExit, requestWorkerStop, workerStopMessage } from "./workerControl";
import { answerTaskStatusQuestions } from "./slackStatus";
import { refreshSlackCards } from "./slackCard";
import { saveLiveChildren } from "./parallel";
import { refresh } from "./refresh";
import { historyTurns, readTurns, renderReport, sinceMs } from "./telemetry";
import { newReviewTask, reviewTask, scanReviews } from "./reviewJob";
import { promisify } from "node:util";
import { sourceFor } from "./sources";
import { renderView, viewLoop } from "./view";
import { readAllUsage } from "./usage";
import { createAccount, runScannerWizard, runSetup, scannerName, setupDone } from "./setup";
import { applyBundle, buildBundle } from "./transfer";
import { cleanupEnvironment } from "./environment";
import { alive, DAEMON_LOG, daemonPid, recordDaemon, startDetached, stopDaemon } from "./daemonctl";
import { banner, cream, dim, mint, ok, bad } from "./theme";
import { FINISHED, retainedTasks } from "../shared/headless.ts";
import { DEFAULT_STATUSES, HOME, host, loadState, LOG_DIR, newId, saveState, updateTask, type Job, type Task } from "./state";

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
    } else if (/^-[a-zA-Z]$/.test(a)) out[a.slice(1)] = true; // short flags like -d stand alone
    else out._.push(a);
  }
  return out;
}
const str = (a: Args, k: string): string | undefined => { const v = a[k]; return typeof v === "string" ? v : Array.isArray(v) ? v[v.length - 1] : undefined; };
const list = (a: Args, k: string): string[] => { const v = a[k]; const items = typeof v === "string" ? [v] : Array.isArray(v) ? v : []; return items.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean); };
const need = (a: Args, k: string): string => { const v = str(a, k); if (!v) fail(`--${k} is required`); return v!; };
const fail = (msg: string): never => { console.error(`consort-cli: ${msg}`); process.exit(2); };

const HELP = `${banner("Consort's ship pipeline, headless", [dim("Tickets in, reviewed PRs out, questions on Slack.")])}

  ${mint("setup")}                                                                   the walk-through: tools, sources, accounts, Slack, permissions

  ${cream("Add a scanner")} ${dim("(step-by-step questions, the same as setup)")}
  ${mint("scanners add clickup")}                                                    build ClickUp tickets into PRs
  ${mint("scanners add review")}                                                     review the PRs that request your review
  ${mint("scanners add sentry")}                                                     turn grouped Sentry issues into ClickUp tickets

  accounts add --provider claude|codex --name <label> [--api-key <key>]   add an AI account (a CLI login unless --api-key)
  accounts list | accounts remove <id>
  slack set --bot-token xoxb-… --user <U…> [--channel <C…>]            where questions and progress go (DM by default)
  slack test
  clickup set-key <key>
  prefix set <branch-prefix>                                             e.g. "bot" → bot/<slug>-<id>
  scanners add --name <n> --source clickup --list|--folder|--space <id> --repo <path> --base main [--tag ai-handle] [--status "to do"]
           [--name-includes <s>] [--name-excludes <s>] [--assignee <who>] [--every 1] [--max-parallel 2]
           [--status-progress "in progress"] [--status-review "in review"] [--status-done complete]
           [--review-models claude:claude-fable-5-1,codex:gpt-6-astra]
  scanners add --name <n> --source github --repo <path> --base main [--tag ai-handle] …
  scanners add --name <n> --source review --repo <path> --reviewer <github-login> [--every 5] [--max-parallel 4]
           reviews open PRs that request that login's review: Fable/Astra overview, Opus/Sol swarm,
           Request changes on Critical/High, otherwise comments and a Slack yes before it approves
  scanners add --name <n> --source sentry [--max-parallel 1] --repo <shared-checkout> --sentry-org <org> --sentry-project <slug> --workspace <id> --list <id> --tag <tag>
           [--sentry-host https://sentry.io] [--environment production] [--query is:unresolved] [--create-status "to do"]
           reads SENTRY_AUTH_TOKEN from the environment; creates bundles for a linked worker; default one open Sentry ticket
  scanners list | scanners remove <id> | scanners enable|disable <id> | scanners scan <id>   (scan: dry run)
                                                                          a scanner watches one place for tickets and hands each match to a worker agent
  scanners configure <id> [--max-parallel N] [--max-open-tasks N] [--max-environments N] [--planning-model provider:model] [--implementation-model provider:model] [--coordination-model provider:model] [--reader-model provider:model] [--frontier-model provider:model] [--<role>-effort low|medium|high|xhigh|max] [--parallel-research N] [--parallel-implementation N] [--max-model-attempts N]
  capacity configure [--max-active-turns N] [--max-open-tasks N] [--max-environments N]
  accounts configure <id> --max-active-turns N
  run [-d]                                                                the daemon: scan, claim, dispatch, watch; -d runs it in the background
  stop [--all]                                                            stop the daemon; --all stops the agents too (they resume on the next run)
  refresh [--pull] [--force] [--skip-install]                             after pulling new Consort code: install, build, stop every process, start the daemon again
                                                                          (waits for running parallel waves unless --force; --pull pulls first)
  view [--once] [--width N] [--no-usage]                                  live table of agents, what they are doing, and each account's plan usage
  work <taskId>                                                           one worker (the daemon runs this)
  tasks list                                                              every task: id, status, ticket, stage, branch, note
  tasks logs <task>                                                       what that agent has been doing              (task or ticket id)
  report [<ticket>] [--since 7d] [--out <file>]                           post-mortem from the agent log: time, tokens and cost by stage, model, account and
                                                                          parallel ticket; how parallel it was; failed turns; the slowest turns
  tasks reboot <task> | reboot --all                                      stop that agent (or every live one) and start it again; it works out where the last run got to
  tasks split <task>                                                      stop that agent, re-split its unfinished build tickets into parallel work, and continue
                                                                          (reboot and split wait for a running parallel wave unless --force)
  tasks retry <task>                                                      queue a failed task again
  tasks release <task>                                                    stop that agent for good and forget the ticket (worktree stays)
  accounts unblock <id>                                                   clear a usage block early
  cli status | cli update                                                 the Claude Code and Codex binaries
  status
  export [--out <file>] [--scanner <id or name>]                          one file with the tokens, accounts and scanners this box runs
  import <file> [--repo-dir <dir>] [--replace]                            set up this box from that file; clones repos it lacks
  accounts login <id>                                                     sign an account in again (after an import without credentials)`;

async function main(argv: string[]) {
  const a = parseArgs(argv);
  const [cmd, sub, ...rest] = a._;
  const s = loadState();
  // commands whose first word is a value, not a subcommand: import <file>, work <task>, reboot <task>
  const key = cmd === "import" || cmd === "work" || cmd === "reboot" || cmd === "report" ? cmd : `${cmd === "jobs" ? "scanners" : cmd ?? "help"} ${sub ?? ""}`.trim(); // "jobs" was the first name for scanners
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
      // no flags: the step-by-step questions (the same as setup); flags stay for scripts
      if (!str(a, "source")) {
        const kind = rest[0]?.toLowerCase();
        if (kind && !["clickup", "github", "review", "sentry"].includes(kind)) fail("scanners add takes clickup, github, review or sentry (or --source … flags)");
        return runScannerWizard(kind);
      }
      const source = need(a, "source") as Job["source"];
      if (source !== "clickup" && source !== "github" && source !== "sentry" && source !== "review") fail("--source must be clickup, github, sentry or review");
      const repo = resolve(need(a, "repo"));
      if (!existsSync(join(repo, ".git"))) fail(`${repo} is not a git checkout`);
      const filters: SourceFilters = { tags: list(a, "tag"), statuses: list(a, "status"), nameIncludes: list(a, "name-includes"), nameExcludes: list(a, "name-excludes"), assignees: list(a, "assignee") };
      const reviewModels: ReviewPick[] = list(a, "review-models").map((m) => { const [provider, model] = m.split(":"); if ((provider !== "claude" && provider !== "codex") || !model) fail(`bad --review-models entry: ${m}`); return { provider: provider as ReviewPick["provider"], model }; });
      const job: Job = {
        id: newId("job"), name: str(a, "name") ?? scannerName(s), source, repo, base: str(a, "base") ?? "main",
        listId: str(a, "list"), ...(str(a, "space") ? { scope: { kind: "space" as const, id: str(a, "space")! } } : str(a, "folder") ? { scope: { kind: "folder" as const, id: str(a, "folder")! } } : str(a, "list") ? { scope: { kind: "list" as const, id: str(a, "list")! } } : {}), filters, everyMinutes: Number(str(a, "every") ?? 1) || 1, maxParallel: Number(str(a, "max-parallel") ?? 2) || 2,
        statuses: { progress: str(a, "status-progress") ?? DEFAULT_STATUSES.progress, review: str(a, "status-review") ?? DEFAULT_STATUSES.review, done: str(a, "status-done") ?? DEFAULT_STATUSES.done },
        ...(reviewModels.length ? { reviewModels } : {}), enabled: true, createdAt: Date.now(),
      };
      if (source === "sentry") {
        job.sentry = { host: str(a, "sentry-host") ?? "https://sentry.io", org: need(a, "sentry-org"), projects: list(a, "sentry-project"), environments: list(a, "environment"), query: str(a, "query") ?? "is:unresolved", token: process.env.SENTRY_AUTH_TOKEN ?? "", workspaceId: need(a, "workspace"), listId: need(a, "list"), ...(str(a, "folder") ? { folderId: str(a, "folder") } : {}), tag: need(a, "tag").toLowerCase(), status: str(a, "create-status") };
        if (!s.clickupKey) fail("Configure ClickUp first: consort-cli clickup set-key <key>");
        validateSentryConfig(job.sentry);
        job.maxParallel = Number(str(a, "max-parallel") ?? 1);
        if (!Number.isSafeInteger(job.maxParallel) || job.maxParallel < 1) fail("Sentry --max-parallel must be a positive whole number");
        job.everyMinutes = Number(str(a, "every") ?? 15) || 15;
      }
      if (source === "review") {
        job.reviewer = need(a, "reviewer").replace(/^@/, "");
        job.everyMinutes = Number(str(a, "every") ?? 5) || 5;
        job.maxParallel = Number(str(a, "max-parallel") ?? 4) || 4; // the reviewer swarm runs this many agents at once
        // a review reuses the box's accounts, Slack, gh login and the repo's environment setup; approvals need Slack
        if (!s.slack) console.log(bad("Slack is not set up: reviews will post comments and request changes, but never approve, because approval waits for your yes on Slack. Run consort-cli slack set …"));
        if (!s.accounts.length) console.log(bad("No AI accounts yet: consort-cli accounts add --provider claude|codex"));
      }
      if (source === "clickup" && !job.scope) fail("--list, --folder or --space <clickup id> is required for a clickup scanner");
      s.jobs.push(job); if (job.source === "sentry") s.jobs.push(sentryWorkerJob(job)); saveState(s);
      console.log(`Added scanner ${job.name} (${job.id}): ${source}${job.scope ? ` ${job.scope.kind} ${job.scope.id}` : ""} every ${job.everyMinutes} min → ${repo} on ${job.base}`);
      return;
    }
    case "scanners list": {
      for (const j of s.jobs) {
        const target = j.source === "review" ? ` PRs for @${j.reviewer}` : j.source === "sentry" ? ` ${j.sentry?.org}/${j.sentry?.projects.join(",")} → ClickUp list ${j.sentry?.listId} #${j.sentry?.tag} (${j.sentry?.status ?? "list default"})` : j.scope ? ` ${j.scope.kind} ${j.scope.id}` : j.listId ? ` list ${j.listId}` : "";
        console.log(`${j.id}  ${j.enabled ? "on " : "off"}  ${j.name.padEnd(20)}  ${j.source}${target}  every ${j.everyMinutes}m  ${j.repo} (${j.base})  filters ${JSON.stringify(j.filters)}  last scan ${j.lastScanAt ? new Date(j.lastScanAt).toLocaleString() : "never"}`);
      }
      if (!s.jobs.length) console.log("No scanners."); return;
    }
    case "capacity configure": {
      for (const [flag, field] of [["max-active-turns", "maxActiveTurns"], ["max-open-tasks", "maxOpenTasks"], ["max-environments", "maxEnvironments"]] as const) {
        const raw = str(a, flag); if (raw === undefined) continue;
        const value = Number(raw); if (!Number.isInteger(value) || value < 1) fail(`--${flag} must be a positive integer`);
        (s.capacity ??= {})[field] = value;
      }
      saveState(s); console.log("Updated installation capacity."); return;
    }
    case "scanners configure": {
      const job = s.jobs.find(j => j.id === rest[0]) ?? fail("no such scanner");
      for (const [flag, field] of [["max-parallel", "maxParallel"], ["max-open-tasks", "maxOpenTasks"], ["max-environments", "maxEnvironments"], ["parallel-research", "parallelResearch"], ["parallel-implementation", "parallelImplementation"], ["max-model-attempts", "maxModelAttempts"]] as const) {
        const raw = str(a, flag); if (raw === undefined) continue;
        const value = Number(raw); if (!Number.isInteger(value) || value < 1) fail(`--${flag} must be a positive integer`);
        job[field] = value;
      }
      for (const role of ["planning", "implementation", "coordination", "reader", "frontier"] as const) {
        for (const raw of list(a, `${role}-model`)) {
          const colon = raw.indexOf(":"); const provider = raw.slice(0, colon); const model = raw.slice(colon + 1);
          if (colon < 1 || !model || (provider !== "claude" && provider !== "codex")) fail(`--${role}-model must be claude:model or codex:model`);
          if ((provider === "claude" && !model.startsWith("claude-")) || (provider === "codex" && !model.startsWith("gpt-"))) fail(`--${role}-model names a model for the wrong provider`);
          job.modelPolicy = { ...job.modelPolicy, [role]: { ...job.modelPolicy?.[role], [provider]: model } };
        }
      }
      for (const role of ["planning", "implementation", "coordination", "reader", "frontier"] as const) {
        const raw = str(a, `${role}-effort`); if (raw === undefined) continue;
        if (!isEffortLevel(raw)) fail(`--${role}-effort must be one of ${EFFORT_LEVELS.join(", ")}`);
        job.effortPolicy = { ...job.effortPolicy, [role]: raw };
      }
      saveState(s); console.log(`Updated scanner ${job.name}.`); return;
    }
    case "accounts configure": {
      const account = s.accounts.find(account => account.id === rest[0]) ?? fail("no such account");
      const value = Number(need(a, "max-active-turns"));
      if (!Number.isInteger(value) || value < 1) fail("--max-active-turns must be a positive integer");
      account.maxActiveTurns = value; saveState(s); console.log(`Updated account ${account.name}.`); return;
    }
    case "scanners remove": { s.jobs = s.jobs.filter((j) => j.id !== rest[0]); saveState(s); console.log("Removed."); return; }
    case "scanners enable": case "scanners disable": { const j = s.jobs.find((x) => x.id === rest[0]) ?? fail("no such scanner"); j!.enabled = sub === "enable"; saveState(s); console.log(`${j!.name}: ${j!.enabled ? "on" : "off"}`); return; }
    case "scanners scan": {
      const j = s.jobs.find((x) => x.id === rest[0]) ?? fail("no such scanner");
      if (j!.source === "sentry") {
        const result = await scanSentry(j!, s.clickupKey, { dryRun: true });
        console.log(`Sentry preview: ${result.issues} issues → ${result.groups} groups; ${result.existing} already ticketed; ${result.preview} would create in ClickUp list ${j!.sentry!.listId} tagged ${j!.sentry!.tag}. No writes performed.`);
        return;
      }
      const tickets = await sourceFor(j!, s.clickupKey).scan();
      const taken = new Set(s.tasks.map((t) => t.ticket.id));
      for (const t of tickets) console.log(`${matchesFilters(t, j!.filters) ? (taken.has(t.id) ? "taken " : "MATCH ") : "skip  "} ${t.id}  ${t.status ?? ""}  [${t.tags.join(", ")}]  ${t.title}`);
      return;
    }

    case "run": {
      const running = daemonPid();
      if (running && running !== process.pid) fail(`the daemon is already running (pid ${running}). Stop it: consort-cli stop`); // run -d writes our own pid before we start
      if (a.d || a.detach) {
        const pid = startDetached(fileURLToPath(import.meta.url));
        console.log(`${ok(`daemon started in the background (pid ${pid})`)}\n  watch:  consort-cli view\n  log:    ${DAEMON_LOG}\n  stop:   consort-cli stop`);
        return;
      }
      recordDaemon();
      return daemon();
    }
    case "refresh": {
      // after pulling new Consort code: install if the lockfile changed, build, then restart the daemon and every worker on it
      const exec = promisify(execFile);
      await refresh({ root: packageRoot(), pull: !!a.pull, force: !!a.force, skipInstall: !!a["skip-install"] }, {
        run: async (cmd, args, cwd) => { console.log(dim(`  $ ${cmd} ${args.join(" ")}`)); await exec(cmd, args, { cwd, maxBuffer: 64 << 20 }).catch((e) => { throw new Error(`${cmd} ${args.join(" ")} failed:\n${(e.stderr || e.stdout || e.message).toString().trim().split("\n").slice(-12).join("\n")}`); }); },
        has: (cmd) => exec(cmd, ["--version"]).then(() => true, () => false),
        tasks: () => loadState().tasks, alive, daemonPid,
        stopAll: () => stopDaemon({ all: true }),
        kill: (pid) => { try { process.kill(pid, "SIGKILL"); } catch {} },
        startDaemon: (entry) => startDetached(entry),
        wait: (ms) => new Promise((r) => setTimeout(r, ms)),
        log: (line) => console.log(ok(line)),
      });
      return;
    }
    case "stop": {
      const r = stopDaemon({ all: !!a.all });
      console.log(r.daemon ? ok(`daemon stopped (pid ${r.daemon})`) : "no daemon was running");
      if (a.all) console.log(r.workers.length ? ok(`${r.workers.length} agent process(es) stopped; their tasks resume on the next run (consort-cli tasks release <task> ends one for good)`) : "no agent processes were running");
      else { const live = s.tasks.filter((t) => t.pid && alive(t.pid)).length; if (live) console.log(dim(`${live} agent process(es) still running; consort-cli stop --all stops them too`)); }
      return;
    }
    case "view": { if (a.once) { const usage = a["no-usage"] ? undefined : await readAllUsage(s.accounts); console.log(renderView(Date.now(), Number(str(a, "width") ?? 0) || undefined, usage)); return; } return viewLoop(); }
    case "accounts unblock": { const acc = s.accounts.find((x) => x.id === rest[0]) ?? fail("no such account"); acc!.blockedUntil = undefined; acc!.blockedWhy = undefined; saveState(s); console.log(`${acc!.name} unblocked.`); return; }
    case "work": {
      const id = sub ?? fail("task id required");
      // a stop (consort-cli stop --all, or the box shutting down) ends the agent process too, so no orphan keeps editing the worktree
      let stopping = false;
      for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, async () => {
        if (stopping) return;
        stopping = true;
        stopAgents();
        // commit and keep every running parallel ticket's work before the process goes (cli/parallel.ts)
        await Promise.race([saveLiveChildren(), new Promise((r) => setTimeout(r, 40_000))]).catch(() => undefined);
        // Keep the pid until exit: the daemon must not start a replacement during Slack delivery.
        updateTask(id!, { activity: `worker stopping (${sig}); progress saved` });
        const current = loadState().tasks.find(t => t.id === id!);
        const reason = current ? workerStopMessage(current, process.pid, sig) : `Worker received ${sig}; task no longer exists.`;
        console.log(`${new Date().toISOString()} [${id}] ${reason}`);
        await notifyTask(id!, "stopped", reason);
        process.exit(0);
      });
      await runTaskUntilFinished(id!, () => (loadState().tasks.find((t) => t.id === id!)?.kind === "review" ? reviewTask(id!) : workTask(id!)), stopAgents, () => stopping);
      return;
    }

    case "tasks list": { for (const t of s.tasks) console.log(`${t.id}  ${t.status.padEnd(10)}  ${t.ticket.id.padEnd(12)}  ${t.feature.stage.padEnd(14)}  ${t.branch}  ${t.note ?? ""}`); if (!s.tasks.length) console.log("No tasks."); return; }
    case "tasks release": {
      const t = s.tasks.find((x) => x.id === rest[0] || x.ticket.id === rest[0]) ?? fail("no such task; use the task id or the ticket id from consort-cli view");
      updateTask(t!.id, { status: "released", finishedAt: Date.now() });
      if (t!.pid) requestWorkerStop(t!.id, t!.pid, "consort-cli tasks release");
      await notifyTask(t!.id, "stopped", "Released by you.");
      if (t!.pid) { try { process.kill(t!.pid); } catch {} }
      updateTask(t!.id, { status: "released", pid: undefined, finishedAt: Date.now() });
      if (t!.runCode) { const r = await cleanupEnvironment(t!.runCode); console.log(`Removed ${r.containers} container(s), ${r.networks} network(s), ${r.volumes} volume(s) of ${t!.runCode}.`); }
      for (const child of loadState().tasks.find(task => task.id === t!.id)?.childEnvironments ?? []) await cleanupEnvironment(child.runCode);
      updateTask(t!.id, { portBase: undefined, envReadyAt: undefined, environmentReservation: undefined, childEnvironments: [] });
      console.log(`Released ${t!.ticket.id}; the worktree ${t!.worktree} is left in place.`); return;
    }
    case "tasks retry": {
      const t = s.tasks.find((x) => x.id === rest[0] || x.ticket.id === rest[0]) ?? fail("no such task; use the task id or the ticket id");
      if (t!.pid && alive(t!.pid)) fail(`${t!.ticket.id} is still running (pid ${t!.pid})`);
      t!.status = "working"; t!.note = undefined; t!.pid = undefined; t!.finishedAt = undefined; t!.restarts = 0; t!.updatedAt = Date.now(); saveState(s);
      console.log(`${t!.ticket.id} queued again; the daemon starts its worker within 15 seconds${daemonPid() ? "" : " once it runs (consort-cli run -d)"}.`); return;
    }
    case "reboot": case "tasks reboot": case "tasks split": {
      // tasks split: the same stop and restart, then the agent re-splits the unfinished build tickets for parallel work
      // stop the ticket's worker and start it again, opening with a turn that works out where the last run got to
      // --all reboots every task that is not finished: the ones running, waiting on you, or watching a PR
      const live = (x: Task) => !["done", "released"].includes(x.status);
      const split = key === "tasks split";
      if (split && a.all) fail("tasks split takes one task or ticket id");
      const want = a.all ? undefined : (key === "reboot" ? sub : rest[0]) ?? fail("task or ticket id required, or --all for every live task; see consort-cli view");
      const targets: Task[] = a.all ? s.tasks.filter(live) : [s.tasks.find((x) => x.id === want || x.ticket.id === want) ?? fail("no such task; use the task id or the ticket id from consort-cli view")!];
      if (a.all && !targets.length) { console.log("No live tasks to reboot."); return; }
      for (const t of targets) {
      if (!live(t!)) fail(`${t!.ticket.id} is ${t!.status}; consort-cli tasks retry runs a finished task again`);
      // a running parallel wave is saved on the way out, but it still has to start its turns again: ask first
      const wave = (t!.childEnvironments ?? []).filter((c) => alive(c.pid));
      if (wave.length && !a.force) fail(`${t!.ticket.id} has a parallel wave running (${wave.length} ticket${wave.length === 1 ? "" : "s"}). Stopping saves their work (and pushes it to consort-wip/ branches) and the next run resumes from it, but their agents must restart. Wait for the wave, or add --force.`);
      if (t!.pid && alive(t!.pid)) {
        // wait for the worker to exit: it saves its state on the way out, and the daemon must not start a second one on top of it
        requestWorkerStop(t!.id, t!.pid, "consort-cli tasks reboot");
        try { process.kill(t!.pid); } catch {}
        // the worker saves its parallel tickets' work on the way out; give it time before forcing
        const until = Date.now() + 60_000;
        while (alive(t!.pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
        if (alive(t!.pid)) {
          try { process.kill(t!.pid, "SIGKILL"); } catch {}
          const killedUntil = Date.now() + 5000;
          while (alive(t!.pid) && Date.now() < killedUntil) await new Promise(r => setTimeout(r, 100));
          if (alive(t!.pid)) fail(`worker ${t!.pid} has not exited; reboot remains held to prevent overlapping workers`);
        }
        console.log(ok(`stopped worker ${t!.pid}`));
      }
      const fresh = loadState();
      const task = fresh.tasks.find((x) => x.id === t!.id)!;
      Object.assign(task, { status: "working", note: undefined, pendingQuestion: undefined, pid: undefined, finishedAt: undefined, restarts: 0, rebootedAt: Date.now(), workerStop: undefined, activity: split ? "re-splitting the build for parallel work; the daemon starts the worker shortly" : "rebooted by you; the daemon starts the worker shortly", updatedAt: Date.now(), ...(split ? { resplitRequested: Date.now() } : {}) });
      saveState(fresh);
      console.log(split
        ? `${task.ticket.id} stopped; the worker restarts within 15 seconds${daemonPid() ? "" : " once the daemon runs (consort-cli run -d)"}, re-splits the unfinished build tickets into parallel work, then builds them in waves.`
        : `${task.ticket.id} rebooted at ${task.feature.stage}; the worker picks up after the last run within 15 seconds${daemonPid() ? "" : " once the daemon runs (consort-cli run -d)"}.`);
      }
      return;
    }
    case "report": {
      // a post-mortem from the telemetry log: what each agent did, how long, tokens and dollars, and what was wasted
      const want = sub;
      const since = sinceMs(str(a, "since"));
      if (str(a, "since") && !since) fail("--since takes a number and d, h or m, e.g. 7d");
      const task = want ? s.tasks.find((x) => x.id === want || x.ticket.id === want) : undefined;
      const ticket = task?.ticket.id ?? want;
      let turns = readTurns(HOME, { ticket, since: since ? Date.now() - since : undefined });
      if (task) turns = [...historyTurns(task, turns[0]?.at ?? Infinity), ...turns];
      const title = ticket ? `Agent report: ${ticket}${task ? ` ${task.ticket.title}` : ""}` : `Agent report: every ticket${since ? ` (last ${str(a, "since")})` : ""}`;
      const md = renderReport(title, turns);
      const out = str(a, "out") ?? join(HOME, "reports", `${ticket ?? "all"}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`);
      mkdirSync(join(out, ".."), { recursive: true });
      writeFileSync(out, md);
      console.log(md);
      console.log(dim(`saved to ${out}`));
      return;
    }
    case "tasks logs": {
      const want = rest[0] ?? fail("task or ticket id required; see consort-cli view");
      const t = s.tasks.find((x) => x.id === want || x.ticket.id === want);
      const f = join(LOG_DIR, `${t?.id ?? want}.log`);
      if (existsSync(f)) { console.log((await import("node:fs")).readFileSync(f, "utf8")); return; }
      if (!t) fail(`no such task; use the task id or the ticket id from consort-cli view`);
      console.log(`${t!.ticket.id} (${t!.id}) has no log yet at ${f}; the worker writes it once it starts${t!.pid ? "" : " (no worker is running for it)"}.`); return;
    }

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


/** the daemon: run due scanners, claim matches, start a worker per task, restart workers that died */
async function daemon() {
  const self = fileURLToPath(import.meta.url);
  mkdirSync(LOG_DIR, { recursive: true });
  console.log(banner("daemon", [dim(`on ${host()}`), dim(`logs in ${LOG_DIR}`), dim("ctrl-c to stop")]));
  const spawnWorker = (t: Task) => {
    const latest = loadState().tasks.find(task => task.id === t.id);
    if (!latest || !canStartWorker(latest, !!latest.pid && alive(latest.pid))) return;
    const out = openSync(join(LOG_DIR, `${t.id}.log`), "a");
    const child = spawn(process.execPath, [self, "work", t.id], { stdio: ["ignore", out, out], env: process.env });
    const s = loadState(); const task = s.tasks.find((x) => x.id === t.id); if (task) { task.pid = child.pid; task.workerStop = undefined; saveState(s); }
    console.log(`${new Date().toISOString()} worker ${child.pid} → ${t.ticket.id} (${t.id})`);
    child.on("exit", async (code, signal) => {
      await handleWorkerExit(t.id, child.pid!, code, signal);
      console.log(`${new Date().toISOString()} worker ${child.pid} for ${t.ticket.id} exited ${code}`);
    });
  };
  let statusCheck: Promise<void> | undefined;
  const checkStatusQuestions = () => {
    if (!statusCheck) statusCheck = Promise.all([
      answerTaskStatusQuestions(alive).catch(e => console.error(`Slack status responder: ${e.message}`)),
      refreshSlackCards().catch(e => console.error(`Slack status cards: ${e.message}`)),
    ]).then(() => {}).finally(() => { statusCheck = undefined; });
  };
  checkStatusQuestions();
  setInterval(checkStatusQuestions, 15_000);
  for (;;) {
    const s = loadState();
    // completed tasks beyond the newest six fall out of the state file (ready-to-merge ones stay); failed ones after a week
    const keep = retainedTasks(s.tasks, Date.now());
    if (keep.length !== s.tasks.length) { s.tasks = keep; saveState(s); }
    for (const t of s.tasks) if (!(t.pid && alive(t.pid))) await flushTaskNotifications(t.id);
    // workers that should be running but are not: the daemon restarted, or the box did
    for (const t of s.tasks) if (["working", "waiting", "monitoring"].includes(t.status) && !(t.pid && alive(t.pid)) && !(t.workerStop && t.workerStop.holdUntil > Date.now())) {
      if (t.pid) await notifyTask(t.id, "stopped", "Worker vanished; restarting.");
      spawnWorker(t);
    }
    // Old producer-only setups gain a bounded dedicated worker without new credentials.
    for (const producer of s.jobs.filter(j => j.source === "sentry")) {
      if (!s.jobs.some(j => j.sentryProducerId === producer.id)) {
        const fresh = loadState();
        if (!fresh.jobs.some(j => j.sentryProducerId === producer.id)) { fresh.jobs.push(sentryWorkerJob(producer)); saveState(fresh); }
      } else {
        const target = sentryWorkerJob(producer);
        const existing = s.jobs.find(j => j.sentryProducerId === producer.id)!;
        if (existing.maxOpenTasks !== target.maxOpenTasks || existing.enabled !== producer.enabled) {
          const fresh = loadState(), worker = fresh.jobs.find(j => j.id === existing.id);
          if (worker) { Object.assign(worker, { maxOpenTasks: target.maxOpenTasks, maxParallel: target.maxParallel, maxEnvironments: target.maxEnvironments, enabled: producer.enabled }); saveState(fresh); }
        }
      }
    }
    for (const job of s.jobs.filter((j) => j.enabled)) {
      const due = !job.lastScanAt || Date.now() - job.lastScanAt >= job.everyMinutes * 60_000;
      if (!due) continue;
      const starting = loadState();
      const startingJob = starting.jobs.find((j) => j.id === job.id);
      if (startingJob) { startingJob.scanStartedAt = Date.now(); saveState(starting); }
      statusEvent("info", `${job.name}: checking ${job.source} for eligible tickets to start`);
      try {
        if (job.source === "sentry") {
          const result = await scanSentry(job, s.clickupKey, { workers: loadState().tasks });
          statusEvent(result.reserved || result.atCapacity ? "warn" : "success", result.atCapacity ? `${job.name}: ${result.activeTickets}/${result.ticketLimit} Sentry ticket slots occupied; no Sentry scan or new workers until a slot frees` : `${job.name}: ${result.issues} Sentry issues → ${result.groups} planned bug bundles; ${result.created} ClickUp tickets created; ${result.existing} existing; ${result.reserved} reserved elsewhere or awaiting reconciliation; ${result.deferred} deferred by the Sentry ticket limit`);
          const after = loadState(); const j = after.jobs.find((x) => x.id === job.id); if (j) { j.lastScanAt = Date.now(); j.scanStartedAt = undefined; saveState(after); }
          continue;
        }
        if (job.source === "review") {
          // PRs assigned to the reviewer or asking it for a review: one review task per PR head (cli/reviewJob.ts)
          const prs = await scanReviews(job, availableTaskSlots(loadState(), job));
          for (const pr of prs) {
            const fresh = loadState();
            const task = newReviewTask(job, pr, Date.now());
            fresh.tasks.push(task); saveState(fresh);
            spawnWorker(task);
            statusEvent("success", `${job.name}: reviewing PR #${pr.number} — ${pr.title}`);
          }
          if (!prs.length) statusEvent("info", `${job.name}: no PRs waiting for @${job.reviewer}'s review`);
          const after = loadState(); const j = after.jobs.find((x) => x.id === job.id); if (j) { j.lastScanAt = Date.now(); j.scanStartedAt = undefined; saveState(after); }
          continue;
        }
        const source = sourceFor(job, s.clickupKey);
        const tickets = await source.scan();
        const live = loadState();
        let slots = availableTaskSlots(live, job);
        const availableSlots = slots;
        const candidates = tickets.filter((t) => !live.tasks.some((old) => old.status !== "released" && old.ticket.id === t.id) && matchesFilters(t, job.filters)).length;
        let claimed = 0;
        const taken = new Set(live.tasks.filter((t) => t.status !== "released").map((t) => t.ticket.id));
        for (const t of tickets) {
          if (slots <= 0) break;
          if (taken.has(t.id) || !matchesFilters(t, job.filters)) continue;
          if (!canClaimSentryTicket(job, t)) continue;
          const comments = await source.comments(t.id).catch(() => []);
          const me = host();
          if (claimedByOther(comments, me, Date.now())) { console.log(`${t.id} claimed by ${claimOf(comments)?.host}; skipping`); continue; }
          // post our marker, then read the ticket again: the earliest fresh marker wins, so two boxes that
          // raced here agree on the winner; the loser removes its marker and moves on
          const handle = await source.claim(t.id, me, Date.now());
          await new Promise((r) => setTimeout(r, 1_500));
          const after = await source.comments(t.id).catch(() => undefined);
          if (after && !claimHeld(after, me, Date.now())) {
            console.log(`${t.id} lost the claim to ${claimOf(after)?.host}; backing off`);
            await source.unclaim(t.id, handle).catch(() => {});
            continue;
          }
          await source.setStatus(t.id, "progress");
          const ticket = await source.ticket(t.id);
          const fresh = loadState();
          const task: Task = { id: newId("task"), ...newTask(job, ticket, fresh.branchPrefix, Date.now()) };
          fresh.tasks.push(task); saveState(fresh);
          console.log(`${new Date().toISOString()} claimed ${t.id} "${t.title}" → ${task.branch}`);
          spawnWorker(task);
          claimed++;
          statusEvent("success", `${job.name}: claimed Ticket ${t.id} — ${t.title}`);
          slots--;
        }
        statusEvent(claimed ? "success" : candidates ? "warn" : "info", `${job.name}: ${tickets.length} tasks checked; ${candidates ? `${candidates} new matching tasks; ${claimed} claimed${availableSlots === 0 ? "; waiting for a free worker slot" : claimed < candidates ? "; remaining tasks deferred" : ""}` : "no new eligible tickets; existing workers continue separately"}`);
        const after = loadState(); const j = after.jobs.find((x) => x.id === job.id); if (j) { j.lastScanAt = Date.now(); j.scanStartedAt = undefined; saveState(after); }
      } catch (e) { statusEvent("error", `${job.name}: ${job.source} scan failed; see daemon log`); console.error(`${new Date().toISOString()} scanner ${job.name} failed: ${(e as Error).message}`); const after = loadState(); const j = after.jobs.find((x) => x.id === job.id); if (j) { j.lastScanAt = Date.now(); j.scanStartedAt = undefined; saveState(after); } }
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

main(process.argv.slice(2)).catch((e) => { console.error(`consort-cli: ${(e as Error).message}`); process.exit(1); });
