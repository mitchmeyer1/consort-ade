/**
 * Save progress on GitHub after each step: the worker, not the agent, commits whatever the turn
 * left uncommitted in the task's worktree and pushes the branch. Secrets-shaped files are never
 * staged (.consort/ is excluded from git already). Hooks are skipped: a checkpoint is a backup,
 * and a slow pre-commit or pre-push test run must not hold up the worker.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PushGuard } from "./phiGate";

export type Git = (args: string[], cwd: string) => Promise<string>;
const realGit: Git = async (args, cwd) => (await promisify(execFile)("git", args, { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout;

/**
 * Stage everything, then put secrets-shaped files and .consort/ back as they were. Naming those
 * paths in `git add` instead fails outright when .gitignore already ignores them (git 2.50: "The
 * following paths are ignored"), and `git rm --cached` would delete one that is committed.
 */
export const NEVER_STAGE = [".consort", ":(glob)**/.env", ":(glob)**/.env.*", ":(glob)**/*.pem", ":(glob)**/*.key"];
export async function stageSafely(git: Git, cwd: string): Promise<void> {
  await git(["add", "-A"], cwd);
  await git(["reset", "-q", "--", ...NEVER_STAGE], cwd);
}

/** `withheld`: the PHI/PII guard stopped the push, and `error` says which lines (cli/phiGate.ts pushGuard) */
export type Checkpoint = { committed: boolean; pushed: boolean; error?: string; withheld?: boolean };

export async function checkpoint(cwd: string, branch: string, message: string, git: Git = realGit, guard?: PushGuard): Promise<Checkpoint> {
  let committed = false;
  try {
    if ((await git(["status", "--porcelain"], cwd)).trim()) {
      await stageSafely(git, cwd);
      const staged = await git(["diff", "--cached", "--name-only"], cwd);
      if (staged.trim()) { await git(["commit", "--no-verify", "-m", message], cwd); committed = true; }
    }
    // push when the branch is new on GitHub or has commits GitHub does not
    const ahead = await git(["rev-list", "--count", "@{u}..HEAD"], cwd).then((n) => Number(n.trim()), () => 1);
    if (!ahead) return { committed, pushed: false };
    const withheld = await guard?.(git, cwd);
    if (withheld) return { committed, pushed: false, error: withheld, withheld: true };
    await git(["push", "--no-verify", "-u", "origin", `HEAD:refs/heads/${branch}`], cwd);
    return { committed, pushed: true };
  } catch (e) {
    return { committed, pushed: false, error: String((e as Error).message ?? e).split("\n")[0] };
  }
}
