/**
 * `consort-cli refresh`: after pulling new Consort code, rebuild and restart everything on it.
 * Order matters: install and build first (a failure leaves the running processes alone), refuse
 * while a parallel wave runs unless --force, then stop the daemon and every worker (each saves
 * its parallel tickets on the way out), wait for them to exit, and start the daemon again on the
 * new build; the daemon restarts each open task's worker. Open `consort-cli view` windows are the
 * owner's to reopen.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./state";

export type RefreshDeps = {
  run: (cmd: string, args: string[], cwd: string) => Promise<void>;
  has: (cmd: string) => Promise<boolean>;
  tasks: () => Task[];
  alive: (pid: number) => boolean;
  daemonPid: () => number | undefined;
  stopAll: () => { daemon?: number; workers: number[] };
  kill: (pid: number) => void;
  startDaemon: (entry: string) => number;
  wait: (ms: number) => Promise<void>;
  log: (line: string) => void;
};
export type RefreshOptions = { root: string; pull?: boolean; force?: boolean; skipInstall?: boolean; stopWaitMs?: number };

/** dependencies need installing when the lockfile changed after the last install */
export function needsInstall(root: string): boolean {
  const lock = ["pnpm-lock.yaml", "package-lock.json"].map((f) => join(root, f)).find(existsSync);
  const marker = [join(root, "node_modules", ".modules.yaml"), join(root, "node_modules", ".package-lock.json")].find(existsSync);
  if (!marker) return true;
  return !!lock && statSync(lock).mtimeMs > statSync(marker).mtimeMs;
}

export async function refresh(o: RefreshOptions, d: RefreshDeps): Promise<void> {
  const pnpm = await d.has("pnpm");
  if (o.pull) { d.log("pulling the latest Consort code"); await d.run("git", ["pull", "--ff-only"], o.root); }
  if (!o.skipInstall && needsInstall(o.root)) {
    d.log("installing dependencies from the lockfile");
    await d.run(pnpm ? "pnpm" : "npm", pnpm ? ["install", "--frozen-lockfile", "--ignore-scripts"] : ["ci", "--ignore-scripts"], o.root);
  }
  d.log("building the CLI");
  await d.run(pnpm ? "pnpm" : "npm", ["run", "build:cli"], o.root);

  // a running parallel wave is saved when stopped, but its agents would have to start over
  const waves = d.tasks().filter((t) => (t.childEnvironments ?? []).some((c) => d.alive(c.pid)));
  if (waves.length && !o.force) throw new Error(`Built, but not restarted: ${waves.map((t) => t.ticket.id).join(", ")} ${waves.length === 1 ? "has" : "have"} a parallel wave running. Run consort-cli refresh again when it finishes, or add --force (the wave's work is saved and resumes).`);

  const before = d.tasks().filter((t) => t.pid && d.alive(t.pid)).length;
  const { daemon, workers } = d.stopAll();
  d.log(`stopping ${daemon ? "the daemon and " : ""}${workers.length} worker${workers.length === 1 ? "" : "s"}; each saves its work first`);
  const pids = [...(daemon ? [daemon] : []), ...workers];
  for (const until = Date.now() + (o.stopWaitMs ?? 75_000); pids.some(d.alive) && Date.now() < until;) await d.wait(500);
  for (const pid of pids.filter(d.alive)) { d.log(`process ${pid} did not exit; forcing it`); d.kill(pid); }

  const pid = d.startDaemon(join(o.root, "out", "cli", "index.js"));
  d.log(`daemon started on the new build (pid ${pid}); it restarts ${before ? `the ${before} task worker${before === 1 ? "" : "s"}` : "task workers"} within 15 seconds`);
  d.log("reopen any consort-cli view window to see the new build");
}
