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
      await slack.post(notification.text, thread, true);
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
