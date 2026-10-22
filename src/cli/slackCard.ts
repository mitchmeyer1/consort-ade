/**
 * The daemon keeps each task thread's first post as a live status card (headless.ts slackCard):
 * working, needs you, paused or done, the step, and when it last changed. It edits the post only
 * when what the card says changes; the thread keeps every detail and question.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { slackCard } from "../shared/headless.ts";
import { loadState, updateTask, type Task } from "./state";
import { Slack } from "./slack";
import { taskSlackLinks } from "./slackLinks";

const run = promisify(execFile);
/** the signed-in gh user's login, looked up once */
let me: Promise<string | undefined> | undefined;
export function githubLogin(): Promise<string | undefined> {
  me ??= run("gh", ["api", "user", "--jq", ".login"], { timeout: 10_000 }).then((r) => r.stdout.trim() || undefined).catch(() => { me = undefined; return undefined; });
  return me;
}

/** "reviewing: @wildebeast" for a review (the PR's author), "author: @you" for a build: GitHub logins, never names (shared/redact.ts) */
export async function cardByline(task: Task, login: (who?: string) => Promise<string | undefined> = githubLogin): Promise<string | undefined> {
  if (task.kind === "review") return task.review?.author ? `reviewing: @${task.review.author}` : undefined;
  const who = await login();
  return who ? `author: @${who}` : undefined;
}

export async function refreshSlackCards(now = Date.now(), slackFor = (cfg: NonNullable<ReturnType<typeof loadState>["slack"]>) => new Slack(cfg)): Promise<void> {
  const state = loadState();
  if (!state.slack) return;
  const slack = slackFor(state.slack);
  const limited = state.accounts.length > 0 && state.accounts.every((a) => a.blockedUntil && a.blockedUntil > now);
  for (const task of state.tasks.filter((t) => t.slackThread)) {
    try {
      const links = await taskSlackLinks(task, state.jobs.find((j) => j.id === task.jobId)?.repo);
      const card = slackCard(task, links, { ownerId: state.slack.userId, limited, at: now, byline: await cardByline(task) });
      if (card.key === task.slackCard) continue;
      await slack.update(task.slackThread!, card.text);
      updateTask(task.id, { slackCard: card.key }, false);
    } catch (e) { console.error(`Slack status card for ${task.ticket.id} failed; retrying: ${(e as Error).message}`); }
  }
}
