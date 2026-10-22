/**
 * What it takes to run a repository locally, learned once and shared by every task on that repo,
 * build or review. After a task's environment turn succeeds, its ENV.md and scripts are saved under
 * ~/.consort-cli/repo-env/<repo>; the next task on the same checkout starts from them and only
 * adapts ports and names, instead of re-reading the whole repo for half an hour.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { ENV_DIR, ENV_DOC, ENVIRONMENT_PROMPT, type TaskEnv } from "../shared/headless.ts";
import { HOME } from "./state";

export const PREVIOUS_DIR = ".consort/env-previous";
const cacheOf = (repo: string) => join(HOME, "repo-env", `${basename(resolve(repo)).replace(/[^\w.-]/g, "_")}-${createHash("sha1").update(resolve(repo)).digest("hex").slice(0, 8)}`);

/** keep the setup a task just proved, for the next task on this repo; the task's own overrides file stays behind */
export function saveRepoEnv(repo: string, worktree: string): boolean {
  const doc = join(worktree, ENV_DOC);
  if (!existsSync(doc)) return false;
  const to = cacheOf(repo);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(join(to, "env"), { recursive: true });
  cpSync(doc, join(to, "ENV.md"));
  const dir = join(worktree, ENV_DIR);
  for (const f of existsSync(dir) ? readdirSync(dir) : []) if (!f.startsWith(".env") && !f.endsWith(".pid") && !f.endsWith(".log")) cpSync(join(dir, f), join(to, "env", f), { recursive: true });
  return true;
}

/** copy the saved setup into a new task's worktree; false when this repo has none yet */
export function seedRepoEnv(repo: string, worktree: string): boolean {
  const from = cacheOf(repo);
  if (!existsSync(join(from, "ENV.md"))) return false;
  const to = join(worktree, PREVIOUS_DIR);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
  return true;
}

/** the environment turn: start from the repo's saved setup when there is one */
export function environmentPrompt(repo: string, worktree: string, env: TaskEnv): string {
  if (!seedRepoEnv(repo, worktree)) return ENVIRONMENT_PROMPT(env);
  return `## This turn: set up this task's local environment, starting from the saved setup

An earlier task on this repository already worked out how to run it. Its notes and scripts are in \`${PREVIOUS_DIR}/\` (ENV.md, and env/ with up.sh, down.sh and any compose override). Reuse them instead of re-reading the whole repository:

1. Copy ${PREVIOUS_DIR}/ENV.md to \`${ENV_DOC}\` and ${PREVIOUS_DIR}/env/* into \`${env.CONSORT_ENV_DIR}/\`.
2. Change every port, container name, label and compose project to this task's own (below), and write \`${env.CONSORT_ENV_FILE}\` with the overrides that point the app at them.
3. Prove it: run up.sh, check the database answers and the app responds on ${env.CONSORT_APP_PORT}, then run down.sh. If something in the repository changed since (a new service, migration or env var), fix the scripts and note it in ENV.md.
4. Report in a few lines: what you reused, what you changed, anything missing on this machine.

If the saved setup does not fit this repository at all, set it up from scratch as ENV.md describes the job: list the services, write the scripts, prove them.`;
}
