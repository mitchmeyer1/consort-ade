import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { allocatePortBase, PORT_BLOCK, taskEnv, type TaskEnv } from "../shared/headless.ts";
import { environmentLimit } from "./capacity";
import { loadState, mutateState, processAlive, type Task } from "./state";

/**
 * The per-task environment on this box (shared/headless.ts): a run code for Docker names and
 * labels, and a port block no other live task holds. Allocation checks the block's key ports
 * are actually free, not just unclaimed. Cleanup removes every container, network and volume
 * labelled with the code, which is how a task leaves nothing behind whether it finished,
 * failed or was released.
 */

const run = promisify(execFile);
const docker = (args: string[]) => run("docker", args, { timeout: 60_000, maxBuffer: 1 << 22 }).then((r) => r.stdout.trim(), () => "");

export const runCodeFor = (task: Pick<Task, "id">) => `consort-${task.id.replace(/^task-/, "")}`;

const free = (port: number) => new Promise<boolean>((resolve) => {
  const srv = createServer();
  srv.once("error", () => resolve(false));
  srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
});

/** the ports the agent is most likely to bind first; a block whose key ports are busy is skipped */
const KEY_OFFSETS = [0, 1, 2, 10, 11, 12, 13];

export async function allocateEnvironment(task: Task): Promise<TaskEnv> {
  const current = loadState().tasks.find(t => t.id === task.id);
  if (current?.portBase) return taskEnv(current.runCode ?? runCodeFor(task), current.portBase);
  let floor: number | undefined;
  for (let tries = 0; tries < 200; tries++) {
    const used = loadState().tasks.flatMap(t => [...(t.id !== task.id && t.portBase ? [t.portBase] : []), ...(t.childEnvironments ?? []).map(child => child.portBase)]);
    const candidate = allocatePortBase(used, floor);
    const checks = await Promise.all(KEY_OFFSETS.map(offset => free(candidate + offset)));
    if (!checks.every(Boolean)) { floor = candidate + PORT_BLOCK; continue; }
    const reserved = mutateState(state => {
      const latest = state.tasks.find(t => t.id === task.id);
      if (!latest) throw new Error(`Task ${task.id} is not in the state file.`);
      if (latest.portBase) return { code: latest.runCode ?? runCodeFor(latest), base: latest.portBase };
      if (state.tasks.some(t => (t.id !== task.id && t.portBase === candidate) || t.childEnvironments?.some(child => child.portBase === candidate))) return undefined;
      latest.portBase = candidate;
      latest.runCode = runCodeFor(latest);
      return { code: latest.runCode, base: candidate };
    });
    if (reserved) return taskEnv(reserved.code, reserved.base);
  }
  throw new Error(`No free port block found for task ${task.id} after 200 probes.`);
}

export const environmentFor = (task: Task): TaskEnv | undefined => task.portBase ? taskEnv(task.runCode ?? runCodeFor(task), task.portBase) : undefined;

/** remove everything Docker holds under the task's code; quiet when Docker is absent */
export async function cleanupEnvironment(code: string): Promise<{ containers: number; networks: number; volumes: number }> {
  const out = { containers: 0, networks: 0, volumes: 0 };
  const ids = async (kind: "ps" | "network" | "volume", label: string) =>
    (await docker(kind === "ps" ? ["ps", "-aq", "--filter", `label=${label}`] : [kind, "ls", "-q", "--filter", `label=${label}`])).split("\n").filter(Boolean);
  for (const label of [`io.consort.run=${code}`, `com.docker.compose.project=${code}`]) {
    const c = await ids("ps", label); if (c.length) { await docker(["rm", "-f", ...c]); out.containers += c.length; }
  }
  for (const label of [`io.consort.run=${code}`, `com.docker.compose.project=${code}`]) {
    const n = await ids("network", label); if (n.length) { await docker(["network", "rm", ...n]); out.networks += n.length; }
    const v = await ids("volume", label); if (v.length) { await docker(["volume", "rm", "-f", ...v]); out.volumes += v.length; }
  }
  return out;
}


export class EnvironmentCapacityError extends Error {
  constructor(taskId: string) { super(`No writer environment capacity for task ${taskId}; run its implementation serially.`); this.name = "EnvironmentCapacityError"; }
}

/** Writers in separate worktrees also need separate Docker names and port blocks. */
export async function withChildEnvironment<T>(taskId: string, childId: string, action: (env: TaskEnv) => Promise<T>): Promise<T> {
  const task = loadState().tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} is not in the state file.`);
  // A restarted worker removes resources left by its crashed writer before reserving more.
  for (const child of task.childEnvironments ?? []) if (!processAlive(child.pid)) {
    await cleanupEnvironment(child.runCode);
    mutateState(s => { const t = s.tasks.find(t => t.id === taskId); if (t) t.childEnvironments = t.childEnvironments?.filter(c => c.id !== child.id); });
  }
  const id = `${childId}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const code = `${runCodeFor(task)}-${id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
  let portBase: number | undefined;
  let floor: number | undefined;
  for (let probes = 0; !portBase; ) {
    const latest = loadState();
    const used = latest.tasks.flatMap(t => [...(t.portBase ? [t.portBase] : []), ...(t.childEnvironments ?? []).map(c => c.portBase)]);
    const candidate = allocatePortBase(used, floor);
    const checks = await Promise.all(KEY_OFFSETS.map(offset => free(candidate + offset)));
    if (!checks.every(Boolean)) {
      if (++probes >= 200) throw new Error(`No free port block found for writer ${childId} after 200 probes.`);
      floor = candidate + PORT_BLOCK; continue;
    }
    const result = mutateState(s => {
      const parent = s.tasks.find(t => t.id === taskId);
      if (!parent || !["working", "waiting", "monitoring"].includes(parent.status)) throw new Error(`Task ${taskId} cannot start writer ${childId}.`);
      const job = s.jobs.find(j => j.id === parent.jobId);
      if (!job) throw new Error(`Missing job for task ${taskId}.`);
      const count = (tasks: Task[]) => tasks.reduce((n,t) => n + (t.portBase || t.envReadyAt || t.environmentReservation ? 1 : 0) + (t.childEnvironments?.length ?? 0), 0);
      if (count(s.tasks.filter(t => t.jobId === job.id)) >= environmentLimit(job) || count(s.tasks) >= (s.capacity?.maxEnvironments ?? 16)) return "full";
      if (s.tasks.some(t => t.portBase === candidate || t.childEnvironments?.some(c => c.portBase === candidate))) return "collision";
      (parent.childEnvironments ??= []).push({ id, portBase: candidate, runCode: code, pid: process.pid });
      return "reserved";
    });
    if (result === "full") throw new EnvironmentCapacityError(taskId);
    if (result === "reserved") portBase = candidate;
    else { if (result === "collision" && ++probes >= 200) throw new Error(`Port reservation contention for writer ${childId}.`); await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  try { return await action(taskEnv(code, portBase)); }
  finally {
    try { await cleanupEnvironment(code); }
    finally { mutateState(s => { const t = s.tasks.find(t => t.id === taskId); if (t) t.childEnvironments = t.childEnvironments?.filter(c => c.id !== id); }); }
  }
}
