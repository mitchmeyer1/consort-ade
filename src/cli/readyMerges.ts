/**
 * A ready-to-merge task has no worker left to watch its PR, so the daemon checks it here: once the PR is merged or
 * closed the task becomes done, which moves it from Ready to merge to Completed on the Slack monitor, its thread
 * hears why, and a merged ticket is marked done as the worker would have.
 */
import { randomUUID } from "node:crypto";
import { loadState, updateTask, type Job, type Task } from "./state.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { slackMessage, slackStatus } from "../shared/headless.ts";

const run = promisify(execFile);
const EVERY_MS = 2 * 60_000;
const lastCheck = new Map<string, number>();
type PrState = "OPEN" | "MERGED" | "CLOSED";

/** The PR's state for the task's branch, read with gh in the job's repo; undefined when gh cannot say. */
async function prState(repo: string, branch: string): Promise<PrState | undefined> {
  const out = await run("gh", ["pr", "view", branch, "--json", "state", "--jq", ".state"], { cwd: repo, timeout: 60_000 }).catch(() => undefined);
  const state = out?.stdout.trim();
  return state === "OPEN" || state === "MERGED" || state === "CLOSED" ? state : undefined;
}

/** The thread post and, for a merge, the ticket marked done; loaded here only, as the worker modules are heavy. */
async function announce(task: Task, job: Job, merged: boolean, clickupKey: string | undefined): Promise<void> {
  const [{ flushTaskNotifications }, { sourceFor }] = await Promise.all([import("./lifecycle"), import("./sources")]);
  if (merged) await sourceFor(job, clickupKey).setStatus(task.ticket.id, "done").catch(() => {});
  await flushTaskNotifications(task.id).catch(() => {});
}

export async function settleReadyMerges(now = Date.now(), read: (repo: string, branch: string) => Promise<PrState | undefined> = prState, after = announce): Promise<string[]> {
  const state = loadState(), settled: string[] = [];
  for (const task of state.tasks.filter((t) => t.status === "ready" && t.branch)) {
    if (now - (lastCheck.get(task.id) ?? 0) < EVERY_MS) continue;
    lastCheck.set(task.id, now);
    const job = state.jobs.find((j) => j.id === task.jobId);
    if (!job) continue;
    const pr = await read(job.repo, task.branch);
    if (pr !== "MERGED" && pr !== "CLOSED") continue;
    const merged = pr === "MERGED";
    const text = slackStatus(slackMessage("completed", `${merged ? "Merged" : "PR closed"}: ${task.ticket.title}\nThe PR was ${merged ? "merged" : "closed without merging"}; this task is done.`), "COMPLETED");
    updateTask(task.id, (t: Task) => ({ status: "done", finishedAt: now, note: merged ? "merged" : "PR closed", activity: merged ? "merged" : "PR closed",
      ...(state.slack ? { notificationQueue: [...(t.notificationQueue ?? []), { id: randomUUID(), text }] } : {}) }));
    await after(task, job, merged, state.clickupKey).catch(() => {});
    settled.push(task.id);
  }
  return settled;
}
