/** Resolve the task's GitHub destination without exposing a remote's credentials to Slack. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Task } from "./state";
import { githubBranchUrl, slackHeading, slackProgress, type SlackTaskLinks } from "../shared/headless.ts";
import { buildProgress } from "./buildProgress";
const run = promisify(execFile);
const remotes = new Map<string, Promise<string>>();
export async function taskSlackLinks(task: Task, repo?: string): Promise<SlackTaskLinks> {
  const heading = slackHeading(task.ticket.title, task.slackIdentity);
  // the step tracker under STATUS: what is done, what runs now (with the build's tickets), what is left
  const progress = task.kind === "review" ? slackProgress(task) : task.feature ? slackProgress(task, buildProgress(task.worktree)) : undefined;
  const pr = task.feature?.prs?.at(-1);
  if (pr) return { ticket: task.ticket.url, github: pr, heading, progress };
  let remote = "";
  if (repo) {
    let pending = remotes.get(repo);
    if (!pending) {
      pending = run("git", ["remote", "get-url", "origin"], { cwd: repo, timeout: 5000 }).then(r => r.stdout.trim()).catch(() => { remotes.delete(repo); return ""; });
      remotes.set(repo, pending);
    }
    remote = await pending;
  }
  return { ticket: task.ticket.url, github: githubBranchUrl(remote, task.branch), heading, progress };
}
