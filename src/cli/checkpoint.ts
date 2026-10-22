/**
 * Save progress on GitHub after each step: the worker, not the agent, commits whatever the turn
 * left uncommitted in the task's worktree and pushes the branch. Secrets-shaped files are never
 * staged (.consort/ is excluded from git already). Hooks are skipped: a checkpoint is a backup,
 * and a slow pre-commit or pre-push test run must not hold up the worker.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type Git = (args: string[], cwd: string) => Promise<string>;
const realGit: Git = async (args, cwd) => (await promisify(execFile)("git", args, { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout;

const NEVER_STAGE = [":(exclude).env", ":(exclude).env.*", ":(exclude)**/.env", ":(exclude)**/.env.*", ":(exclude)*.pem", ":(exclude)**/*.pem", ":(exclude)*.key", ":(exclude)**/*.key"];

export type Checkpoint = { committed: boolean; pushed: boolean; error?: string };

export async function checkpoint(cwd: string, branch: string, message: string, git: Git = realGit): Promise<Checkpoint> {
  let committed = false;
  try {
    if ((await git(["status", "--porcelain"], cwd)).trim()) {
      await git(["add", "-A", "--", ".", ...NEVER_STAGE], cwd);
      const staged = await git(["diff", "--cached", "--name-only"], cwd);
      if (staged.trim()) { await git(["commit", "--no-verify", "-m", message], cwd); committed = true; }
    }
    // push when the branch is new on GitHub or has commits GitHub does not
    const ahead = await git(["rev-list", "--count", "@{u}..HEAD"], cwd).then((n) => Number(n.trim()), () => 1);
    if (!ahead) return { committed, pushed: false };
    await git(["push", "--no-verify", "-u", "origin", `HEAD:refs/heads/${branch}`], cwd);
    return { committed, pushed: true };
  } catch (e) {
    return { committed, pushed: false, error: String((e as Error).message ?? e).split("\n")[0] };
  }
}
