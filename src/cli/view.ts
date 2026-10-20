import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ago, diffCell, FINISHED, parseShortstat, taskStep, usageBars, usageBarText, visibleTasks } from "../shared/headless.ts";
import type { ConnectorUsage } from "../shared/usage.ts";
import { readAllUsage } from "./usage";
import { daemonPid } from "./daemonctl";
import { resetLabel } from "../shared/seatPool.ts";
import { loadState, LOG_DIR, type Task } from "./state";

/**
 * `consort-cli view`: a terminal dashboard that redraws every couple of seconds from the state
 * file. One row per task: ticket, title, stage, status, the account it is on, what the worker
 * is doing right now, and how long it has run. Finished tasks stay for two hours, then drop
 * off. Below the table: the accounts (and which are blocked until when) and the scanners with
 * their next scan. `q` quits.
 */

import { amber, banner, blue, bold, cream, dim, green, mint, red } from "./theme";

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s).padEnd(n);
const statusColor: Record<string, (s: string) => string> = { working: mint, waiting: amber, monitoring: blue, ready: green, done: green, failed: red, released: dim };
const color = (s: string, status: string) => (statusColor[status] ?? ((x: string) => x))(s);

/** the worker's log: how many lines, and the last one */
const logOf = (task: Task): { lines: number; last: string } => {
  const f = join(LOG_DIR, `${task.id}.log`);
  if (!existsSync(f)) return { lines: 0, last: "" };
  const lines = readFileSync(f, "utf8").trimEnd().split("\n").filter(Boolean);
  return { lines: lines.length, last: (lines[lines.length - 1] ?? "").replace(/^\S+ \[[^\]]*\] /, "") };
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
  const tasks = visibleTasks(s.tasks, now).sort((a, b) => (FINISHED.includes(a.status) ? 1 : 0) - (FINISHED.includes(b.status) ? 1 : 0) || b.updatedAt - a.updatedAt);
  const accountName = (id?: string) => s.accounts.find((a) => a.id === id)?.name ?? "";
  const cols = { ticket: 12, title: 26, step: 5, stage: 14, next: 14, status: 10, account: 12, ports: 12, age: 8, log: 5, diff: 14 };
  const fixed = Object.values(cols).reduce((a, b) => a + b, 0) + 12 * 2;
  const activityW = Math.max(20, width - fixed);
  const lines: string[] = [];
  const active = tasks.filter((t) => !FINISHED.includes(t.status)).length;
  const pid = daemonPid();
  lines.push(banner("view", [
    pid ? green(`daemon running (pid ${pid})`) : red("daemon not running: consort-cli run -d"),
    `${mint(`${active} active`)} ${dim(`· ${new Date(now).toLocaleTimeString()} · q to quit`)}`,
  ]));
  lines.push("");
  lines.push(dim([pad("TICKET", cols.ticket), pad("TITLE", cols.title), pad("STEP", cols.step), pad("STAGE", cols.stage), pad("NEXT", cols.next), pad("STATUS", cols.status), pad("ACCOUNT", cols.account), pad("PORTS", cols.ports), pad("AGE", cols.age), pad("LOG", cols.log), pad("DIFF", cols.diff), "ACTIVITY"].join("  ")));
  if (!tasks.length) lines.push(dim("  nothing in flight; the daemon claims tickets as scanners come due"));
  for (const t of tasks) {
    const acct = accountName(t.accountIds.claude ?? t.accountIds.codex);
    const log = logOf(t);
    const activity = t.activity || t.note || log.last || "";
    const diff = diffCell(diffOf(t, s.jobs.find((j) => j.id === t.jobId)?.base, now));
    const age = FINISHED.includes(t.status) ? `done ${ago(now - (t.finishedAt ?? t.updatedAt))}` : ago(now - t.startedAt);
    const finished = FINISHED.includes(t.status);
    const cell = (s: string, f: (x: string) => string) => (finished ? dim(s) : f(s));
    const step = taskStep(t, s.jobs.find((j) => j.id === t.jobId)?.reviewModels?.length || 3);
    lines.push([cell(pad(t.ticket.id, cols.ticket), mint), cell(pad(t.ticket.title, cols.title), cream), cell(pad(`${step.n}/${step.total}`, cols.step), mint), cell(pad(step.name, cols.stage), (x) => x), cell(pad(step.next, cols.next), dim), cell(pad(t.status, cols.status), (x) => color(x, t.status)), cell(pad(acct, cols.account), dim), cell(pad(t.portBase ? `${t.portBase}-${t.portBase + 99}` : "", cols.ports), dim), cell(pad(age, cols.age), dim), cell(pad(log.lines ? String(log.lines) : "", cols.log), dim), cell(pad(diff, cols.diff), (x) => (!diff || diff.startsWith("+0 −0") ? dim(x) : mint(x))), cell(pad(activity, activityW), (x) => x)].join("  "));
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
  if (!s.jobs.length) lines.push(dim("  none: consort-cli scanners add …"));
  for (const j of s.jobs) {
    const next = j.lastScanAt ? Math.max(0, j.lastScanAt + j.everyMinutes * 60_000 - now) : 0;
    lines.push(`  ${pad(j.name, 20)} ${pad(`${j.source}${j.scope ? ` ${j.scope.kind} ${j.scope.id}` : j.listId ? ` list ${j.listId}` : ""}`, 22)} ${j.enabled ? mint(`next scan in ${ago(next)}`) : dim("off")}  ${dim(j.repo)}`);
  }
  lines.push("");
  lines.push(cream(bold("Commands")));
  lines.push(`  ${mint("consort-cli stop")}                         stop the daemon; agents keep working and the next run adopts them`);
  lines.push(`  ${mint("consort-cli stop --all")}                   stop the daemon and every agent; tasks resume on the next run`);
  lines.push(`  ${mint("consort-cli tasks release <ticket>")}       stop one agent for good and forget the ticket (worktree stays)`);
  lines.push(`  ${mint("consort-cli tasks logs <ticket or task>")}  what an agent has been doing`);
  return lines.join("\n");
}

export async function viewLoop(intervalMs = 2_000, usageEveryMs = 60_000): Promise<void> {
  const out = process.stdout;
  let usage: Map<string, ConnectorUsage> | undefined = new Map();
  const draw = () => { out.write(`\x1b[2J\x1b[H${renderView(Date.now(), undefined, usage)}\n`); };
  let reading = false;
  const readUsage = async () => { if (reading) return; reading = true; try { usage = await readAllUsage(loadState().accounts); } finally { reading = false; } draw(); };
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
