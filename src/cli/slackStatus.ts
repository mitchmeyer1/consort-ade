/** The daemon answers status questions even while the task worker is busy, paused, or finished. */
import { brief, isTaskStatusQuestion, slackMessage, slackStatus, taskHealth, taskStep } from "../shared/headless.ts";
import { loadState, updateTask } from "./state";
import { Slack } from "./slack";
import { taskSlackLinks } from "./slackLinks";

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
        if (!message.bot_id && message.user === state.slack.userId && isTaskStatusQuestion(message.text ?? "")) {
          const fresh = loadState();
          const current = fresh.tasks.find(t => t.id === task.id);
          if (!current) break;
          const job = fresh.jobs.find(j => j.id === current.jobId);
          const health = taskHealth(current, fresh.accounts, { workerAlive: !!current.pid && alive(current.pid), logAgeMs: Date.now() - current.updatedAt }, Date.now());
          const status = health.label === "COMPLETED" ? "COMPLETED" : ["WAITING", "LIMIT"].includes(health.label) ? "WAITING" : ["RUNNING", "STALLED"].includes(health.label) ? "RUNNING" : "STOPPED";
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
