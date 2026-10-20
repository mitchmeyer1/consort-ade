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

import { amber, blue, bold, cream, dim, glyph, green, mint, red } from "./theme";

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s).padEnd(n);
const statusColor: Record<string, (s: string) => string> = { working: mint, waiting: amber, monitoring: blue, ready: green, done: green, failed: red, released: dim };
const color = (s: string, status: string) => (statusColor[status] ?? ((x: string) => x))(s);

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
  const active = tasks.filter((t) => !FINISHED.includes(t.status)).length;
  lines.push(`${glyph()} ${cream(bold("Consort"))} ${mint("consort-cli")} ${dim(`· ${new Date(now).toLocaleTimeString()} ·`)} ${mint(`${active} active`)} ${dim("· q to quit")}`);
  lines.push("");
  lines.push(dim([pad("TICKET", cols.ticket), pad("TITLE", cols.title), pad("STAGE", cols.stage), pad("STATUS", cols.status), pad("ACCOUNT", cols.account), pad("AGE", cols.age), "ACTIVITY"].join("  ")));
  if (!tasks.length) lines.push(dim("  nothing in flight; the daemon claims tickets as jobs come due"));
  for (const t of tasks) {
    const acct = accountName(t.accountIds.claude ?? t.accountIds.codex);
    const activity = t.activity || t.note || lastLogLine(t) || "";
    const age = FINISHED.includes(t.status) ? `done ${ago(now - (t.finishedAt ?? t.updatedAt))}` : ago(now - t.startedAt);
    const finished = FINISHED.includes(t.status);
    const cell = (s: string, f: (x: string) => string) => (finished ? dim(s) : f(s));
    lines.push([cell(pad(t.ticket.id, cols.ticket), mint), cell(pad(t.ticket.title, cols.title), cream), cell(pad(t.feature.stage, cols.stage), (x) => x), cell(pad(t.status, cols.status), (x) => color(x, t.status)), cell(pad(acct, cols.account), dim), cell(pad(age, cols.age), dim), cell(pad(activity, activityW), (x) => x)].join("  "));
  }
  lines.push("");
  lines.push(cream(bold("Accounts")));
  if (!s.accounts.length) lines.push(dim("  none: consort-cli accounts add --provider claude --name work"));
  for (const a of s.accounts) {
    const blocked = a.blockedUntil && a.blockedUntil > now;
    const inUse = s.tasks.filter((t) => !FINISHED.includes(t.status) && Object.values(t.accountIds).includes(a.id)).length;
    lines.push(`  ${pad(a.provider, 7)} ${pad(a.name, 20)} ${blocked ? amber(`blocked until ${resetLabel(a.blockedUntil, now)}${a.blockedWhy ? ` · ${a.blockedWhy.slice(0, 50)}` : ""}`) : green("available")}${inUse ? dim(`  · ${inUse} task${inUse === 1 ? "" : "s"}`) : ""}`);
  }
  lines.push("");
  lines.push(cream(bold("Jobs")));
  if (!s.jobs.length) lines.push(dim("  none: consort-cli jobs add …"));
  for (const j of s.jobs) {
    const next = j.lastScanAt ? Math.max(0, j.lastScanAt + j.everyMinutes * 60_000 - now) : 0;
    lines.push(`  ${pad(j.name, 20)} ${pad(`${j.source}${j.listId ? `:${j.listId}` : ""}`, 22)} ${j.enabled ? mint(`next scan in ${ago(next)}`) : dim("off")}  ${dim(j.repo)}`);
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
