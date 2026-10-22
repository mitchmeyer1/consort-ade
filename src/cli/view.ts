import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ago, costCell, FINISHED, parseShortstat, taskHealth, taskStep, scanCountdown, usageBars, usageBarText, visibleTasks } from "../shared/headless.ts";
import { usageBlock, type ConnectorUsage } from "../shared/usage.ts";
import { recentStatusEvents } from "./statusLog";
import { readAllUsage, saveUsage } from "./usage";
import { alive, daemonPid } from "./daemonctl";
import { resetLabel } from "../shared/seatPool.ts";
import { loadState, LOG_DIR, type Task } from "./state";
import { stepLabel } from "./buildProgress";

/**
 * `consort-cli view`: a terminal dashboard that redraws every couple of seconds from the state
 * file. Three lines per task: a row with ticket, title, stage (with build progress, "Build 7/18"),
 * status, the account it is on and how long it has run; then what the worker is doing right now,
 * full width; then a blank line. Finished tasks stay for a day, then drop
 * off. Below the table: the accounts (and which are blocked until when) and the scanners with
 * their next scan. `q` quits.
 */

import { amber, banner, blue, bold, cream, dim, green, mint, red } from "./theme";

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s).padEnd(n);

/** the worker's log: how many lines, and the last one */
const logOf = (task: Task, now: number): { lines: number; last: string; ageMs?: number } => {
  const f = join(LOG_DIR, `${task.id}.log`);
  if (!existsSync(f)) return { lines: 0, last: "" };
  const lines = readFileSync(f, "utf8").trimEnd().split("\n").filter(Boolean);
  return { lines: lines.length, last: (lines[lines.length - 1] ?? "").replace(/^\S+ \[[^\]]*\] /, ""), ageMs: Math.max(0, now - statSync(f).mtimeMs) };
};

/** lines changed in the task's worktree against its base (committed and not), untracked files counted; cached a few seconds per task */
const diffCache = new Map<string, { at: number; value?: { files: number; added: number; removed: number } }>();
const diffOf = (task: Task, base: string | undefined, now: number): { files: number; added: number; removed: number } | undefined => {
  const hit = diffCache.get(task.id);
  if (hit && now - hit.at < 5_000) return hit.value;
  let value: { files: number; added: number; removed: number } | undefined;
  if (task.worktree && existsSync(join(task.worktree, ".git"))) {
    try {
      const git = (args: string[]) => execFileSync("git", ["-C", task.worktree!, ...args], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
      const stat = parseShortstat(git(["diff", "--shortstat", base ? `origin/${base}` : "HEAD"]));
      const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
      let added = 0;
      for (const f of untracked.slice(0, 200)) { try { added += readFileSync(join(task.worktree, f), "utf8").split("\n").length; } catch {} }
      value = { files: stat.files + untracked.length, added: stat.added + added, removed: stat.removed };
    } catch { value = undefined; }
  }
  diffCache.set(task.id, { at: now, value });
  return value;
};

export function renderView(now = Date.now(), width = process.stdout.columns || 140, usage?: Map<string, ConnectorUsage>): string {
  const s = loadState();
  s.accounts = s.accounts.map((a) => { const u = usage?.get(a.id); const block = u && usageBlock(u, now); return block ? { ...a, blockedUntil: Math.max(a.blockedUntil ?? 0, block.until), blockedWhy: block.reason } : a; });
  const tasks = visibleTasks(s.tasks, now).sort((a, b) => (FINISHED.includes(a.status) ? 1 : 0) - (FINISHED.includes(b.status) ? 1 : 0) || b.updatedAt - a.updatedAt);
  const accountName = (id?: string) => s.accounts.find((a) => a.id === id)?.name ?? "";
  const activityW = Math.max(20, width - 10);
  const lines: string[] = [];
  const active = tasks.filter((t) => !FINISHED.includes(t.status)).length;
  const pid = daemonPid();
  lines.push(banner("view", [
    pid ? green(`daemon running (pid ${pid})`) : red("daemon not running: consort-cli run -d"),
    `${mint(`${active} active`)} ${dim(`· ${new Date(now).toLocaleTimeString()} · q to quit`)}`,
  ]));
  lines.push("");
  lines.push(`${cream(bold("Tickets"))} ${dim(`· ${active} active${tasks.length > active ? `, ${tasks.length - active} finished` : ""}`)}`);
  if (!tasks.length) lines.push(dim("  nothing in flight; the daemon claims tickets as scanners come due"));
  // like an account: ticket, title and status on one line; the details and what it is doing indented under it
  for (const t of tasks) {
    const acct = accountName(t.activeProvider ? t.accountIds[t.activeProvider] : t.accountIds.claude ?? t.accountIds.codex);
    const log = logOf(t, now);
    const health = taskHealth(t, s.accounts, { workerAlive: !!(t.pid && alive(t.pid)), logAgeMs: Math.min(log.ageMs ?? Infinity, now - t.updatedAt) }, now);
    const healthPaint = (x: string) => (health.tone === "complete" ? blue(bold(x)) : health.tone === "ok" ? green(x) : health.tone === "warn" ? amber(x) : health.tone === "bad" ? red(x) : dim(x));
    const activity = (health.tone === "bad" || health.tone === "warn") && health.note ? `${health.note}${t.activity && t.activity !== health.note ? ` · ${t.activity}` : ""}` : t.activity || t.note || log.last || "";
    const changed = diffOf(t, s.jobs.find((j) => j.id === t.jobId)?.base, now);
    const diff = changed && (changed.added || changed.removed) ? `+${changed.added} −${changed.removed} in ${changed.files} file${changed.files === 1 ? "" : "s"}` : "";
    const finished = FINISHED.includes(t.status);
    const age = finished ? `done ${ago(now - (t.finishedAt ?? t.updatedAt))} ago` : `running ${ago(now - t.startedAt)}`;
    const quiet = finished && t.status !== "failed";
    const paint = (x: string, f: (y: string) => string) => (quiet ? dim(x) : f(x));
    const step = taskStep(t, 3);
    const stage = finished ? step.name : stepLabel(step.name, t.worktree, now);
    lines.push(`  ${paint(pad(t.ticket.id, 12), mint)} ${paint(pad(t.ticket.title, 34), (x) => cream(bold(x)))} ${healthPaint(health.label)}`);
    const details = [
      `${dim("step")} ${paint(`${step.n}/${step.total}`, mint)} ${paint(stage, (x) => bold(x))}${step.next && step.next !== stage ? dim(` → ${step.next}`) : ""}`,
      acct ? paint(pad(acct, 22).trimEnd(), dim) : "",
      t.cost ? paint(costCell(t.cost), amber) : "",
      t.portBase ? `${dim("ports")} ${paint(`${t.portBase}-${t.portBase + 99}`, dim)}` : "",
      dim(age),
      log.lines ? dim(`${log.lines} log lines`) : "",
      diff ? paint(diff, mint) : "",
    ].filter(Boolean);
    lines.push(`          ${details.join(dim("  ·  "))}`);
    if (activity) lines.push(`          ${paint(pad(activity, activityW).trimEnd(), (x) => (health.tone === "bad" ? red(x) : health.tone === "warn" ? amber(x) : x))}`);
  }
  lines.push("");
  const readAt = usage ? Math.max(0, ...[...usage.values()].map((u) => u.at)) : 0;
  lines.push(`${cream(bold("Accounts"))} ${dim(usage ? (readAt ? `· usage read ${ago(now - readAt)} ago` : "· reading usage…") : "· usage: consort-cli view reads it once a minute")}`);
  if (!s.accounts.length) lines.push(dim("  none: consort-cli accounts add --provider claude --name work"));
  const paint = (t: string, tone: "ok" | "high" | "full") => (tone === "full" ? red(t) : tone === "high" ? amber(t) : mint(t));
  for (const a of s.accounts) {
    const blocked = a.blockedUntil && a.blockedUntil > now;
    const inUse = s.tasks.filter((t) => !FINISHED.includes(t.status) && Object.values(t.accountIds).includes(a.id)).length;
    const state = blocked ? amber(`blocked until ${resetLabel(a.blockedUntil, now)}${a.blockedWhy ? ` · ${a.blockedWhy.slice(0, 50)}` : ""}`) : green("available");
    lines.push(`  ${pad(a.provider, 7)} ${pad(a.name, 20)} ${state}${inUse ? dim(`  · ${inUse} task${inUse === 1 ? "" : "s"}`) : ""}`);
    const u = usage?.get(a.id);
    if (!u) continue;
    if (u.unavailable || !u.windows.length) { lines.push(dim(`          ${u.unavailable ?? "no meters"}`)); continue; }
    const bars = usageBars(u.windows);
    const soonest = bars.map((b) => b.resetsAt).filter((t): t is number => !!t).sort((x, y) => x - y)[0];
    lines.push(`          ${bars.map((b) => usageBarText(b, 10, paint)).join("   ")}${u.blocked ? red(`   ${u.blocked}`) : ""}${soonest ? dim(`   5h resets ${resetLabel(bars.find((b) => b.short === "5h")?.resetsAt ?? soonest, now)}`) : ""}${u.plan ? dim(`   ${u.plan}`) : ""}`);
  }
  lines.push("");
  lines.push(cream(bold("Scanners")));
  lines.push(dim("  Finds eligible tickets and starts workers; workers handle code, PR feedback, and CI."));
  if (!s.jobs.length) lines.push(dim("  none: consort-cli scanners add …"));
  for (const j of s.jobs) {
    lines.push(`  ${pad(j.name, 20)} ${pad(`${j.source}${j.source === "sentry" ? ` → list ${j.sentry?.listId ?? "?"} #${j.sentry?.tag ?? "?"}` : j.scope ? ` ${j.scope.kind} ${j.scope.id}` : j.listId ? ` list ${j.listId}` : ""}`, 22)} ${j.enabled ? pid ? mint(scanCountdown(j, now)) : amber("paused · daemon stopped") : dim("off")}  ${dim(`${j.repo}${j.source === "sentry" ? ` → ClickUp ${j.sentry?.listId ?? "?"} #${j.sentry?.tag ?? "?"}` : ""}`)}`);
  }
  lines.push("");
  lines.push(cream(bold("Status log · last 8")));
  const events = recentStatusEvents();
  if (!events.length) lines.push(dim("  no scan or Slack activity recorded yet"));
  for (const event of events) {
    const color = event.tone === "success" ? green : event.tone === "error" ? red : event.tone === "warn" ? amber : blue;
    lines.push(`  ${dim(new Date(event.at).toLocaleTimeString())}  ${color(pad(event.text, Math.max(20, width - 18)).trimEnd())}`);
  }
  lines.push("");
  lines.push(cream(bold("Commands")));
  lines.push(`  ${mint("consort-cli stop")}                         stop the daemon; agents keep working and the next run adopts them`);
  lines.push(`  ${mint("consort-cli stop --all")}                   stop the daemon and every agent; tasks resume on the next run`);
  lines.push(`  ${mint("consort-cli tasks reboot <ticket>")}        stop one agent and start it again; it works out where the last run got to`);
  lines.push(`  ${mint("consort-cli reboot --all")}                 the same for every live agent`);
  lines.push(`  ${mint("consort-cli tasks release <ticket>")}       stop one agent for good and forget the ticket (worktree stays)`);
  lines.push(`  ${mint("consort-cli tasks logs <ticket or task>")}  what an agent has been doing`);
  lines.push(`  ${mint("consort-cli help")}                         every command`);
  return lines.join("\n");
}

export async function viewLoop(intervalMs = 1_000, usageEveryMs = 60_000): Promise<void> {
  const out = process.stdout;
  let usage: Map<string, ConnectorUsage> | undefined = new Map();
  const draw = () => { out.write(`\x1b[2J\x1b[H${renderView(Date.now(), undefined, usage)}\n`); };
  let reading = false;
  const readUsage = async () => { if (reading) return; reading = true; try { usage = await readAllUsage(loadState().accounts); saveUsage(usage); } finally { reading = false; } draw(); };
  draw();
  void readUsage();
  const timer = setInterval(draw, intervalMs);
  const usageTimer = setInterval(() => void readUsage(), usageEveryMs);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (k: string) => { if (k === "q" || k === "\u0003") { clearInterval(timer); clearInterval(usageTimer); process.stdin.setRawMode(false); out.write("\n"); process.exit(0); } });
  }
  await new Promise(() => {});
}
