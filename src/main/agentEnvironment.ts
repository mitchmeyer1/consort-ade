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

export const TESTING_PROMPT = `You can run tests and install the dependencies needed for them in this worktree using your shell tool. Installing dependencies is pre-approved: plain install commands (pnpm/npm/yarn/bun install or ci, pip install -r, poetry install, uv sync, bundle install, cargo fetch, go mod download, and similar) run without asking the user, so never report a task as blocked on missing dependencies. Network access is enabled; package caches are configured under .consort/cache so they are writable inside the workspace sandbox.
Before testing, read the repository's setup instructions, package manager/version, lockfile, and test scripts. A fresh Git worktree does not include installed dependencies. If the test runner or a module is missing, install dependencies including development dependencies using the repository's package manager and a frozen lockfile when supported, then rerun the relevant tests. Keep dependencies local to this worktree; do not symlink node_modules from another checkout or change dependency versions just to run tests.
An install that fails because the local store or cache is incomplete, or with an offline/prefer-offline error, is not a blocker: rerun it without any offline flag so it fetches from the registry. If installation or tests still fail after that retry, report the exact command and error, distinguishing setup failures from failing tests. Never describe tests as passing unless you actually ran them successfully. Respect this chat's PHI requirements during setup and testing.`;

// Dependency installs are the one class of shell command that should never wait on the user: a fresh worktree has
// no node_modules, and the agent stalls on "vitest not found" otherwise. Only plain installs qualify — commands that
// add or remove packages, run scripts, or do anything else still go through the normal permission flow.
const INSTALL = [
  /^(?:pnpm|npm|yarn|bun)(?:\s+(?:install|i|ci))?(?:\s+-{1,2}[\w-]+(?:=\S+)?)*$/,          // pnpm install --frozen-lockfile, npm ci, bare yarn
  /^(?:pnpm|yarn)\s+(?:fetch|install\s+--offline|install\s+--prefer-offline)(?:\s+-{1,2}[\w-]+)*$/,
  /^corepack\s+(?:enable|prepare|use|install)(?:\s+\S+)*$/,
  /^(?:python3?\s+-m\s+)?pip3?\s+install(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+(?:-r\s+\S+|-e\s+\.\S*|\.\S*)(?:\s+-{1,2}[\w-]+(?:=\S+)?)*$/, // pip install -r requirements.txt, pip install -e .
  /^(?:poetry\s+install|pipenv\s+(?:install|sync)|uv\s+(?:sync|pip\s+install\s+-r\s+\S+))(?:\s+-{1,2}[\w-]+(?:=\S+)?)*$/,
  /^(?:bundle\s+install|cargo\s+fetch|go\s+mod\s+(?:download|tidy|vendor)|composer\s+install|mix\s+deps\.get|dotnet\s+restore|gradle\s+dependencies|mvn\s+dependency:resolve)(?:\s+-{1,2}[\w-]+(?:=\S+)?)*$/,
];
// Harmless prefixes that may precede an install in the same command line.
const PREFIX = [/^cd(?:\s+\S+)?$/, /^export\s+\w+=\S*$/, /^\w+=\S*$/];

export function isInstallCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  let cmd = command.trim();
  // the agents wrap commands as `/bin/zsh -lc "..."` — unwrap one layer
  const wrapped = /^\/bin\/(?:ba|z)?sh\s+-lc\s+(["'])([\s\S]*)\1$/.exec(cmd);
  if (wrapped) cmd = wrapped[2].trim();
  if (!cmd || /[`$<>]|\n/.test(cmd)) return false; // no substitution, redirection, or multi-line scripts
  const parts = cmd.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  if (parts.some((p) => p.includes("|"))) return false;
  const installs = parts.filter((p) => INSTALL.some((r) => r.test(p.replace(/^(?:\w+=\S*\s+)+/, ""))));
  const rest = parts.filter((p) => !installs.includes(p));
  return installs.length > 0 && rest.every((p) => PREFIX.some((r) => r.test(p)));
}
