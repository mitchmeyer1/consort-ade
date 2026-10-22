/** Persist task activity transitions and retry Slack delivery without repeating pause alerts. */
import { problemOf, slackAsk, slackLines, slackMessage, slackStatus } from "../shared/headless.ts";
import { randomUUID } from "node:crypto";
import { loadState, updateTask, type Task } from "./state";
import { Slack } from "./slack";
import { taskSlackLinks } from "./slackLinks";

const deliveries = new Map<string, Promise<void>>();
export function flushTaskNotifications(taskId: string): Promise<void> {
  const existing = deliveries.get(taskId);
  if (existing) return existing;
  const delivery = deliver(taskId).finally(() => deliveries.delete(taskId));
  deliveries.set(taskId, delivery);
  return delivery;
}
async function deliver(taskId: string): Promise<void> {
  const state = loadState();
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task?.notificationQueue?.length || !state.slack) return;
  try {
    const slack = new Slack(state.slack);
    const links = await taskSlackLinks(task, state.jobs.find(j => j.id === task.jobId)?.repo);
    let thread = task.slackThread;
    if (!thread) {
      thread = await slack.post(slackStatus(`*${task.ticket.title}* — ${task.ticket.url}`, task.lifecycle === "completed" ? "COMPLETED" : task.lifecycle === "stopped" ? "STOPPED" : task.lifecycle === "paused" && task.status !== "monitoring" ? "WAITING" : "RUNNING", links));
      updateTask(taskId, { slackThread: thread });
    }
    for (const notification of task.notificationQueue) {
      await slack.post(slackStatus(notification.text, undefined, links), thread);
      updateTask(taskId, (t) => ({ notificationQueue: t.notificationQueue?.filter((n) => n.id !== notification.id) }));
    }
  } catch (e) { console.error(`Slack task notification failed; queued for retry: ${(e as Error).message}`); }
}

export async function notifyTask(taskId: string, activity: NonNullable<Task["lifecycle"]>, reason: string): Promise<void> {
  const state = loadState();
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  if (task.lifecycle !== activity || (["paused", "monitoring"].includes(activity) && task.pauseReason !== reason)) {
    const verb = activity === "monitoring" ? "Running" : activity === "running" ? (task.lifecycle ? "Resumed" : "Started") : activity === "paused" ? "Paused" : activity === "completed" ? "Completed — ready for you to merge" : "Stopped";
    const notification = { id: randomUUID(), text: slackStatus(slackMessage(activity === "completed" ? "completed" : ["running", "monitoring"].includes(activity) ? "update" : activity === "paused" ? "waiting" : "stopped",`${verb}: ${task.ticket.title}\n${reason}`), activity === "paused" ? "WAITING" : ["running", "monitoring"].includes(activity) ? "RUNNING" : activity === "completed" ? "COMPLETED" : "STOPPED") };
    updateTask(taskId, (t) => ({ lifecycle: activity, pauseReason: ["paused", "monitoring"].includes(activity) ? reason : undefined,
      ...(state.slack ? { notificationQueue: [...(t.notificationQueue ?? []), notification] } : {}) }));
  }
  await flushTaskNotifications(taskId);
}

/** Keep recoverable worker failures in the task's Slack thread, rather than ending the task. */
export async function runTaskUntilFinished(taskId: string, work: () => Promise<void>, stop: () => void, isStopping: () => boolean = () => false): Promise<void> {
  for (;;) {
    if (isStopping()) return;
    try {
      const task = loadState().tasks.find((t) => t.id === taskId);
      if (!task || task.status === "released") return;
      if ((task.restarts ?? 0) >= 4) await askForRecovery(taskId, new Error(task.note ?? "The worker exited repeatedly."), `${task.restarts} restarts in a row, each one crashed again`);
      await work();
      if (isStopping()) return;
      const finished = loadState().tasks.find((t) => t.id === taskId);
      if (!finished || ["ready", "done", "released"].includes(finished.status)) return;
      throw new Error("Worker returned before reviewer approvals and CI completion.");
    } catch (e) {
      if (isStopping()) return;
      stop();
      await askForRecovery(taskId, e);
    }
  }
}

/** the worker stopped on its own: tell the owner where, what broke, what the agent last said, and wait for a reply */
async function askForRecovery(taskId: string, cause: unknown, tried?: string): Promise<void> {
  const crashed = loadState().tasks.find((t) => t.id === taskId);
  const where = crashed?.feature?.stage && crashed.feature.stage !== "In Review" ? crashed.feature.stage : crashed?.status === "monitoring" ? "PR watch" : "worker";
  const problem = problemOf(cause, where, { recent: crashed?.recent, tried, ask: "Reply with what to do; the task stays open." });
  const reason = [problem.what, ...(problem.why ?? [])].join(" ");
  updateTask(taskId, { status: "waiting", note: reason, activity: "waiting for recovery guidance in Slack" });
  await notifyTask(taskId, "paused", "Needs a hand. Reply here; the task stays open.");
  for (;;) {
    const state = loadState();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task || task.status === "released") return;
    if (!state.slack) throw new Error("Slack must be configured to recover this task.");
    try {
      await flushTaskNotifications(taskId);
      const thread = loadState().tasks.find((t) => t.id === taskId)?.slackThread;
      if (!thread) throw new Error("Waiting for the task's Slack thread.");
      const slack = new Slack(state.slack);
      const questions = task.pendingQuestion?.questions ?? [slackLines.problem(problem, task.ticket?.url)];
      const ts = task.pendingQuestion?.afterTs ?? await slack.post(slackStatus(slackAsk(questions.join("\n")), "WAITING", await taskSlackLinks(task, state.jobs.find(j => j.id === task.jobId)?.repo)), thread);
      updateTask(taskId, { pendingQuestion: { questions, afterTs: ts } });
      const answer = await slack.waitForReply(thread, ts, { onTick: () => { updateTask(taskId, {}); void flushTaskNotifications(taskId); } });
      if (!answer) continue;
      updateTask(taskId, { status: "working", pendingQuestion: undefined, restarts: 0, note: undefined, recoveryGuidance: answer });
      await notifyTask(taskId, "running", "Answer received.");
      return;
    } catch (e) {
      console.error(`Recovery is waiting for Slack: ${(e as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
}
