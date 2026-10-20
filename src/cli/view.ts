import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ago, FINISHED, visibleTasks } from "../shared/headless.ts";
import { resetLabel } from "../shared/seatPool.ts";
import { loadState, LOG_DIR, type Task } from "./state";

/**
 * `consort-cli view`: a terminal dashboard that redraws every couple of seconds from the state
 * file. One row per task: ticket, title, stage, status, the account it is on, what the worker
 * is doing right now, and how long it has run. Finished tasks stay for two hours, then drop
 * off. Below the table: the accounts (and which are blocked until when) and the jobs with
 * their next scan. `q` quits.
 */

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s).padEnd(n);
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const color = (s: string, c: number) => `\x1b[${c}m${s}\x1b[0m`;
const statusColor: Record<string, number> = { working: 36, waiting: 33, monitoring: 34, ready: 32, done: 32, failed: 31, released: 90 };

const lastLogLine = (task: Task): string => {
  const f = join(LOG_DIR, `${task.id}.log`);
  if (!existsSync(f)) return "";
  const lines = readFileSync(f, "utf8").trimEnd().split("\n");
  return (lines[lines.length - 1] ?? "").replace(/^\S+ \[[^\]]*\] /, "");
};

export function renderView(now = Date.now(), width = process.stdout.columns || 140): string {
  const s = loadState();
  const tasks = visibleTasks(s.tasks, now).sort((a, b) => (FINISHED.includes(a.status) ? 1 : 0) - (FINISHED.includes(b.status) ? 1 : 0) || b.updatedAt - a.updatedAt);
  const accountName = (id?: string) => s.accounts.find((a) => a.id === id)?.name ?? "";
  const cols = { ticket: 12, title: 30, stage: 14, status: 10, account: 14, age: 8 };
  const fixed = Object.values(cols).reduce((a, b) => a + b, 0) + 7 * 2;
  const activityW = Math.max(20, width - fixed);
  const lines: string[] = [];
  lines.push(bold(`consort-cli · ${new Date(now).toLocaleTimeString()} · ${tasks.filter((t) => !FINISHED.includes(t.status)).length} active · q to quit`));
  lines.push("");
  lines.push(dim([pad("TICKET", cols.ticket), pad("TITLE", cols.title), pad("STAGE", cols.stage), pad("STATUS", cols.status), pad("ACCOUNT", cols.account), pad("AGE", cols.age), "ACTIVITY"].join("  ")));
  if (!tasks.length) lines.push(dim("  nothing in flight; the daemon claims tickets as jobs come due"));
  for (const t of tasks) {
    const acct = accountName(t.accountIds.claude ?? t.accountIds.codex);
    const activity = t.activity || t.note || lastLogLine(t) || "";
    const age = FINISHED.includes(t.status) ? `done ${ago(now - (t.finishedAt ?? t.updatedAt))}` : ago(now - t.startedAt);
    const row = [pad(t.ticket.id, cols.ticket), pad(t.ticket.title, cols.title), pad(t.feature.stage, cols.stage), pad(t.status, cols.status), pad(acct, cols.account), pad(age, cols.age), pad(activity, activityW)].join("  ");
    lines.push(FINISHED.includes(t.status) ? dim(row) : color(row, statusColor[t.status] ?? 0));
  }
  lines.push("");
  lines.push(bold("Accounts"));
  if (!s.accounts.length) lines.push(dim("  none: consort-cli accounts add --provider claude --name work"));
  for (const a of s.accounts) {
    const blocked = a.blockedUntil && a.blockedUntil > now;
    const inUse = s.tasks.filter((t) => !FINISHED.includes(t.status) && Object.values(t.accountIds).includes(a.id)).length;
    lines.push(`  ${pad(a.provider, 7)} ${pad(a.name, 20)} ${blocked ? color(`blocked until ${resetLabel(a.blockedUntil, now)}${a.blockedWhy ? ` · ${a.blockedWhy.slice(0, 50)}` : ""}`, 33) : color("available", 32)}${inUse ? dim(`  · ${inUse} task${inUse === 1 ? "" : "s"}`) : ""}`);
  }
  lines.push("");
  lines.push(bold("Jobs"));
  if (!s.jobs.length) lines.push(dim("  none: consort-cli jobs add …"));
  for (const j of s.jobs) {
    const next = j.lastScanAt ? Math.max(0, j.lastScanAt + j.everyMinutes * 60_000 - now) : 0;
    lines.push(`  ${pad(j.name, 20)} ${pad(`${j.source}${j.listId ? `:${j.listId}` : ""}`, 22)} ${j.enabled ? `next scan in ${ago(next)}` : dim("off")}  ${dim(j.repo)}`);
  }
  return lines.join("\n");
}

export async function viewLoop(intervalMs = 2_000): Promise<void> {
  const out = process.stdout;
  const draw = () => { out.write(`\x1b[2J\x1b[H${renderView()}\n`); };
  draw();
  const timer = setInterval(draw, intervalMs);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (k: string) => { if (k === "q" || k === "\u0003") { clearInterval(timer); process.stdin.setRawMode(false); out.write("\n"); process.exit(0); } });
  }
  await new Promise(() => {});
}
