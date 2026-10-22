/**
 * The daemon keeps each task thread's first post as a live status card (headless.ts slackCard):
 * working, needs you, paused or done, the step, and when it last changed. It edits the post only
 * when what the card says changes; the thread keeps every detail and question.
 */
import { slackCard } from "../shared/headless.ts";
import { loadState, updateTask } from "./state";
import { Slack } from "./slack";
import { taskSlackLinks } from "./slackLinks";

export async function refreshSlackCards(now = Date.now(), slackFor = (cfg: NonNullable<ReturnType<typeof loadState>["slack"]>) => new Slack(cfg)): Promise<void> {
  const state = loadState();
  if (!state.slack) return;
  const slack = slackFor(state.slack);
  const limited = state.accounts.length > 0 && state.accounts.every((a) => a.blockedUntil && a.blockedUntil > now);
  for (const task of state.tasks.filter((t) => t.slackThread)) {
    try {
      const links = await taskSlackLinks(task, state.jobs.find((j) => j.id === task.jobId)?.repo);
      const card = slackCard(task, links, { ownerId: state.slack.userId, limited, at: now });
      if (card.key === task.slackCard) continue;
      await slack.update(task.slackThread!, card.text);
      updateTask(task.id, { slackCard: card.key }, false);
    } catch (e) { console.error(`Slack status card for ${task.ticket.id} failed; retrying: ${(e as Error).message}`); }
  }
}
