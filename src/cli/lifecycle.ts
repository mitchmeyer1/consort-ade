/** Persist task activity transitions and retry Slack delivery without repeating pause alerts. */
import { randomUUID } from "node:crypto";
import { loadState, updateTask, type Task } from "./state";
import { Slack } from "./slack";

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
    let thread = task.slackThread;
    if (!thread) {
      thread = await slack.post(`*${task.ticket.title}* — ${task.ticket.url}`);
      updateTask(taskId, { slackThread: thread });
    }
    for (const notification of task.notificationQueue) {
      await slack.post(notification.text, thread);
      updateTask(taskId, (t) => ({ notificationQueue: t.notificationQueue?.filter((n) => n.id !== notification.id) }));
    }
  } catch (e) { console.error(`Slack task notification failed; queued for retry: ${(e as Error).message}`); }
}

export async function notifyTask(taskId: string, activity: NonNullable<Task["lifecycle"]>, reason: string): Promise<void> {
  const state = loadState();
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  if (task.lifecycle !== activity || (activity === "paused" && task.pauseReason !== reason)) {
    const verb = activity === "running" ? (task.lifecycle ? "Resumed" : "Started") : activity === "paused" ? "Paused" : activity === "completed" ? "Completed — ready for you to merge" : "Stopped";
    const notification = { id: randomUUID(), text: `*${verb}: ${task.ticket.title}*\n${reason}` };
    updateTask(taskId, (t) => ({ lifecycle: activity, pauseReason: activity === "paused" ? reason : undefined,
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
      if ((task.restarts ?? 0) >= 4) await askForRecovery(taskId, task.note ?? "The worker exited repeatedly.");
      await work();
      if (isStopping()) return;
      const finished = loadState().tasks.find((t) => t.id === taskId);
      if (!finished || ["ready", "done", "released"].includes(finished.status)) return;
      throw new Error("Worker returned before reviewer approvals and CI completion.");
    } catch (e) {
      if (isStopping()) return;
      stop();
      await askForRecovery(taskId, (e as Error).message);
    }
  }
}

async function askForRecovery(taskId: string, reason: string): Promise<void> {
  updateTask(taskId, { status: "waiting", note: reason, activity: "waiting for recovery guidance in Slack" });
  await notifyTask(taskId, "paused", "Waiting for your recovery guidance in Slack; this task remains open.");
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
      const questions = task.pendingQuestion?.questions ?? [`I could not continue: ${reason.slice(0, 1200)}. What should I do? I will resume after your answer and keep working until both requested reviewers approve and CI passes.`];
      const ts = task.pendingQuestion?.afterTs ?? await slack.post(questions.join("\n"), thread);
      updateTask(taskId, { pendingQuestion: { questions, afterTs: ts } });
      const answer = await slack.waitForReply(thread, ts, { onTick: () => { updateTask(taskId, {}); void flushTaskNotifications(taskId); } });
      if (!answer) continue;
      updateTask(taskId, { status: "working", pendingQuestion: undefined, restarts: 0, note: undefined, recoveryGuidance: answer });
      await notifyTask(taskId, "running", "Your Slack recovery answer arrived; continuing this task.");
      return;
    } catch (e) {
      console.error(`Recovery is waiting for Slack: ${(e as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
}
