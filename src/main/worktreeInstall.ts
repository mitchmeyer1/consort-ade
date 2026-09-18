import { promises as fs } from "node:fs";
import { join } from "node:path";

const exists = (path: string) => fs.stat(path).then(() => true, () => false);

/**
 * A worktree's dependencies cannot be shared with the repo's. pnpm links a workspace
 * package with a relative symlink (`@aligned-mono/core -> ../../../core`), so a worktree
 * pointed at the repo's `node_modules` resolves through to the *repo's* checkout and
 * builds the wrong source. Each worktree needs its own tree — which is cheap, because
 * every package manager here hardlinks out of a store the repo has already filled.
 */
const MANAGERS = [
  // Frozen, so the branch gets exactly its own lockfile; offline, so a warm store is reused.
  { lockfile: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile --prefer-offline" },
  { lockfile: "bun.lockb", command: "bun install --frozen-lockfile" },
  { lockfile: "bun.lock", command: "bun install --frozen-lockfile" },
  { lockfile: "yarn.lock", command: "yarn install --immutable" },
  { lockfile: "package-lock.json", command: "npm ci --prefer-offline --no-audit --no-fund" },
] as const;

/**
 * The command that gives `worktree` the dependencies `repo` already has, or undefined when
 * there is nothing to do.
 *
 * Only mirrors a setup that exists: a repo whose own `node_modules` is missing has never
 * been installed, and a first-ever install is the user's call, not ours.
 */
export async function installCommand(repo: string, worktree: string): Promise<string | undefined> {
  if (!(await exists(join(worktree, "package.json")))) return undefined;
  if (await exists(join(worktree, "node_modules"))) return undefined;
  if (!(await exists(join(repo, "node_modules")))) return undefined;
  for (const { lockfile, command } of MANAGERS) {
    if (await exists(join(worktree, lockfile))) return command;
  }
  return undefined;
}
