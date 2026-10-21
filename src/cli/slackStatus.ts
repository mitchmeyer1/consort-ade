/**
 * The daemon answers status questions even while the task worker is busy, paused, or finished.
 * Every other owner message in the thread, except the answer to a pending question and a bare
 * "thanks", is queued on the task as an owner update (with its files) for the worker to apply.
 */
import { brief, isTaskStatusQuestion, slackMessage, slackStatus, taskHealth, taskStep } from "../shared/headless.ts";
import { loadState, updateTask } from "./state";
import { Slack, type SlackThreadMessage } from "./slack";
import { taskSlackLinks } from "./slackLinks";
import { downloadSlackFiles, isAcknowledgement } from "./ownerUpdates";
import { existsSync } from "node:fs";

export async function answerTaskStatusQuestions(alive: (pid: number) => boolean): Promise<void> {
  const state = loadState();
  if (!state.slack) return;
  const slack = new Slack(state.slack);
  for (const task of state.tasks.filter(t => t.slackThread)) {
    // Catch recent unanswered questions when an older daemon is upgraded.
    const afterTs = task.slackStatusAfterTs ?? String(Math.max(Number(task.slackThread), Date.now() / 1000 - 10 * 60));
    try {
      const messages = (await slack.threadMessages(task.slackThread!, afterTs))
        .filter(m => Number(m.ts) > Number(afterTs)).sort((a, b) => Number(a.ts) - Number(b.ts));
      if (!messages.length && !task.slackStatusAfterTs) updateTask(task.id, { slackStatusAfterTs: afterTs }, false);
      for (const message of messages) {
        const fromOwner = !message.bot_id && message.user === state.slack.userId;
        if (fromOwner && !isTaskStatusQuestion(message.text ?? "")) {
          await queueOwnerUpdate(slack, state.slack.botToken, task.id, message);
          updateTask(task.id, { slackStatusAfterTs: message.ts }, false);
          continue;
        }
        if (fromOwner && isTaskStatusQuestion(message.text ?? "")) {
          const fresh = loadState();
          const current = fresh.tasks.find(t => t.id === task.id);
          if (!current) break;
          const job = fresh.jobs.find(j => j.id === current.jobId);
          const health = taskHealth(current, fresh.accounts, { workerAlive: !!current.pid && alive(current.pid), logAgeMs: Date.now() - current.updatedAt }, Date.now());
          const status = health.label === "COMPLETED" ? "COMPLETED" : health.label === "WAITING" ? "WAITING" : ["RUNNING", "STALLED", "LIMIT"].includes(health.label) ? "RUNNING" : "STOPPED";
          const step = taskStep(current);
          const action = status === "COMPLETED" ? "Ready for you to merge; Consort will not merge." : (current.status === "monitoring" ? current.activity ?? health.note : health.note ?? current.activity) ?? current.note ?? "Preparing the task.";
          const text = slackMessage(status === "COMPLETED" ? "completed" : status === "RUNNING" ? "update" : status === "WAITING" ? "waiting" : "stopped",`Step ${step.n}/${step.total} (${step.name}): ${brief(action, 650).replace(/[.!?]+$/, "")}.`);
          await slack.post(slackStatus(text, status, await taskSlackLinks(current, job?.repo)), task.slackThread);
        }
        updateTask(task.id, { slackStatusAfterTs: message.ts }, false);
      }
    } catch (e) { console.error(`Slack status check for ${task.ticket.id} failed; retrying: ${(e as Error).message}`); }
  }
}

const OPEN = ["working", "waiting", "monitoring"];

/** queue one owner message as an update, unless it is the answer the worker is waiting for */
async function queueOwnerUpdate(slack: Slack, token: string, taskId: string, message: SlackThreadMessage): Promise<void> {
  const state = loadState();
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  const text = (message.text ?? "").trim();
  const files = message.files ?? [];
  // the first owner message with text after a pending question is its answer (headless.ts replyAfter); the worker reads it
  const after = Number(task.pendingQuestion?.afterTs);
  const answering = !!task.pendingQuestion && !!text && Number(message.ts) > after && !(task.answeredTs ?? []).some(ts => Number(ts) > after);
  if (answering) updateTask(taskId, t => ({ answeredTs: [...(t.answeredTs ?? []), message.ts].slice(-20) }), false);
  if (!files.length && (answering || isAcknowledgement(text))) return;
  const links = await taskSlackLinks(task, state.jobs.find(j => j.id === task.jobId)?.repo);
  if (!OPEN.includes(task.status) && task.status !== "ready") {
    await slack.post(slackStatus(slackMessage("stopped", `This task is ${task.status === "done" ? `closed (${task.note ?? "PR closed"})` : task.status}, so I can't apply this update. Post it on a new ticket.`), "STOPPED", links), task.slackThread);
    return;
  }
  const saved = files.length && existsSync(task.worktree) ? await downloadSlackFiles(token, files, task.worktree, message.ts) : { saved: [], failed: files.map(f => `${f.name ?? "file"}: the task folder is not created yet`) };
  const update = { ts: message.ts, text: answering ? "(Files attached to the answer above; the answer itself was already applied.)" : text, files: saved.saved, ...(saved.failed.length ? { failedFiles: saved.failed } : {}), at: Date.now() };
  const reopen = task.status === "ready";
  updateTask(taskId, t => ({ ownerUpdates: [...(t.ownerUpdates ?? []).filter(u => u.ts !== message.ts), update], ...(reopen ? { status: "monitoring", finishedAt: undefined, note: undefined, activity: "applying an owner update from Slack" } : {}) }), false);
  const busy = task.pendingQuestion && !answering ? " after you answer the question above" : reopen ? "; reopening the task" : " after the current step";
  const failed = saved.failed.length ? `\n• Could not download: ${saved.failed.join("; ")}` : "";
  await slack.post(slackStatus(slackMessage("update", `Got your update${saved.saved.length ? ` and ${saved.saved.length} file${saved.saved.length === 1 ? "" : "s"}` : ""}. I'll update the ticket and the code${busy}.${failed}`), "RUNNING", links), task.slackThread);
}
