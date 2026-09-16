import { join } from "node:path";

// Keep dependency downloads writable under the same sandbox as the checkout.
// Do not share node_modules: workspace links must resolve to this branch's code.
export function agentEnvironment(cwd: string, inherited: NodeJS.ProcessEnv): Record<string, string> {
  const env = Object.fromEntries(Object.entries(inherited).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const cache = join(cwd, ".consort", "cache");
  return {
    ...env,
    npm_config_cache: join(cache, "npm"),
    npm_config_store_dir: join(cache, "pnpm"),
    YARN_CACHE_FOLDER: join(cache, "yarn"),
    COREPACK_HOME: join(cache, "corepack"),
    XDG_CACHE_HOME: cache,
  };
}

export const TESTING_PROMPT = `You can run tests and install the dependencies needed for them in this worktree using your shell tool. Network access is enabled; package caches are configured under .consort/cache so they are writable inside the workspace sandbox.
Before testing, read the repository's setup instructions, package manager/version, lockfile, and test scripts. A fresh Git worktree does not include installed dependencies. If the test runner is missing, install dependencies including development dependencies using the repository's package manager and a frozen lockfile when supported, then rerun the relevant tests. Keep dependencies local to this worktree; do not symlink node_modules from another checkout or change dependency versions just to run tests.
Do not stop after an offline install fails because the cache is incomplete: retry with registry access. If installation or tests still fail, report the command and concrete error, distinguishing setup failures from failing tests. Never describe tests as passing unless you actually ran them successfully. Respect this chat's permission and PHI requirements during setup and testing.`;
