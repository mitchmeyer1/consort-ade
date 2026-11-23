/** Destructive cleanup runs only after the task-chat confirmation; commands never use a shell. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadState, processAlive, updateTask, type Task } from "./state";
import { killTask } from "./workerControl";
import { destroyTaskEnvironments } from "./environment";
import { killTree } from "./testSession";

type Run = (command: string, args: string[], cwd: string) => Promise<string>;
export type AbandonDeps = {
  run: Run;
  stop: (task: Task) => Promise<void>;
  cleanup: (task: Task) => Promise<void>;
};
const exec = promisify(execFile);
const defaults: AbandonDeps = {
  run: (cmd, args, cwd) => exec(cmd, args, { cwd, timeout: 120_000, maxBuffer: 4 << 20 }).then(r => r.stdout.trim()),
  stop: async task => {
    await killTask(task.id, undefined, { notify: false, preserveResources: true });
    for (const pid of new Set([task.testSession?.tunnelPid, ...(task.testSession?.pids ?? [])].filter((p): p is number => !!p && p > 1))) {
      if (pid === process.pid) throw new Error("A test process points to Consort itself; cleanup stopped");
      killTree(pid);
      for (let i = 0; i < 20 && processAlive(pid); i++) await new Promise(r => setTimeout(r, 100));
      if (processAlive(pid)) process.kill(pid, "SIGKILL");
      for (let i = 0; i < 20 && processAlive(pid); i++) await new Promise(r => setTimeout(r, 100));
      if (processAlive(pid)) throw new Error(`Test process ${pid} is still running; cleanup stopped`);
    }
  },
  cleanup: destroyTaskEnvironments,
};

export async function abandonTask(taskId: string, deps: AbandonDeps = defaults): Promise<string> {
  const state = loadState();
  const task = state.tasks.find(t => t.id === taskId);
  const job = state.jobs.find(j => j.id === task?.jobId);
  if (!task || !job) throw new Error("Task or repository was not found");
  if (task.kind === "review") throw new Error("Review tasks do not own the PR author's branch");
  const branch = task.branch;
  if (state.tasks.some(t => t.id !== taskId && !["done", "released"].includes(t.status) && (t.worktree === task.worktree || (t.branch === branch && state.jobs.find(j => j.id === t.jobId)?.repo === job.repo)))) throw new Error("Another task still uses this branch or worktree");
  if (!branch || [job.base, "main", "master", "development", "develop"].includes(branch) || resolve(task.worktree) === resolve(job.repo)) throw new Error("Refusing to delete a base branch or the main checkout");
  const run = (cmd: string, args: string[]) => deps.run(cmd, args, job.repo);
  await run("git", ["check-ref-format", "--branch", branch]);
  const remote = await run("git", ["remote", "get-url", "origin"]);
  const slug = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(remote)?.[1];
  if (!slug) throw new Error("The origin remote is not a GitHub repository");
  const repository = JSON.parse(await run("gh", ["repo", "view", slug, "--json", "defaultBranchRef"]));
  if (!repository.defaultBranchRef?.name || branch === repository.defaultBranchRef.name) throw new Error("Refusing to delete the repository's default branch");
  const worktrees = (await run("git", ["worktree", "list", "--porcelain"])).split("\n\n").map(block => ({
    path: /^worktree (.+)$/m.exec(block)?.[1], branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1],
  }));
  const own = worktrees.find(w => w.path && resolve(w.path) === resolve(task.worktree));
  if (!own && existsSync(task.worktree)) throw new Error("The task directory is not a registered worktree; cleanup stopped");
  if (own && own.branch !== branch) throw new Error("The local worktree no longer has this task's branch");
  const parallelDir = join(dirname(resolve(task.worktree)), `.parallel-${basename(resolve(task.worktree))}`);
  if (parallelDir === resolve(job.repo) || state.tasks.some(t => t.id !== taskId && t.worktree && (resolve(t.worktree) === parallelDir || dirname(resolve(t.worktree)) === parallelDir))) throw new Error("The parallel worktree directory is used by another checkout");
  const children = worktrees.filter(w => w.path && dirname(resolve(w.path)) === parallelDir && !w.branch);
  if (worktrees.some(w => w.path && dirname(resolve(w.path)) === parallelDir && w.branch)) throw new Error("A parallel worktree has a named branch; cleanup stopped");
  const listPrs = async (): Promise<{ number: number; state: string; headRepositoryOwner: { login: string }; headRepository: { name: string } | null }[]> => JSON.parse(await run("gh", ["pr", "list", "--repo", slug, "--head", branch, "--state", "all", "--limit", "1000", "--json", "number,state,headRepositoryOwner,headRepository"]));
  await listPrs();
  const [owner, name] = slug.split("/");
  // Resolve every target before stopping anything; a failed lookup never authorizes partial deletion.
  await deps.stop(task);
  // A worker finishing its current turn can publish a PR while it stops.
  const connected = (await listPrs()).filter(pr => pr.headRepositoryOwner?.login?.toLowerCase() === owner.toLowerCase() && pr.headRepository?.name?.toLowerCase() === name.toLowerCase());
  for (const pr of connected.filter(pr => pr.state === "OPEN")) await run("gh", ["pr", "close", String(pr.number), "--repo", slug]);
  if (await run("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`])) await run("git", ["push", "origin", "--delete", branch]);
  await deps.cleanup(task);
  for (const w of [...children, ...(own ? [own] : [])]) await run("git", ["worktree", "remove", "--force", w.path!]);
  rmSync(parallelDir, { recursive: true, force: true });
  if (await run("git", ["branch", "--list", "--", branch])) await run("git", ["branch", "-D", "--", branch]);
  updateTask(taskId, { status: "released", pid: undefined, runCode: undefined, portBase: undefined, envReadyAt: undefined, testSession: undefined, environmentReservation: undefined, childEnvironments: [], ownerUpdates: [], pendingQuestion: undefined, pendingAbandon: undefined, activity: "abandoned; resources cleaned up", note: "abandoned by you; branch and worktree removed", finishedAt: Date.now() });
  return `Closed ${connected.filter(pr => pr.state === "OPEN").length} PR(s), deleted remote branch ${branch}, removed the local worktree and cleaned up its resources. Consort will not pick this ticket up again.`;
}
