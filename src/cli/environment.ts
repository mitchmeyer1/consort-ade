import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { allocatePortBase, ENV_DIR, ENV_DOC, PORT_BLOCK, PORT_FLOOR, taskEnv, type TaskEnv } from "../shared/headless.ts";
import { environmentLimit } from "./capacity";
import { loadState, mutateState, processAlive, type CliState, type EnvSlot, type Task } from "./state";

/**
 * The machine's sets of local services (databases, caches…), shared by the tasks on each
 * repository (shared/headless.ts taskEnv: a run code for Docker names and labels, and a port
 * block). A task claims a free set for its repository while it works and hands it back when it
 * waits (on the owner, on GitHub, on AI credits) or finishes; it starts a new set only when every
 * set for the repository is held. Claims go through the locked state file, so two workers never
 * take the same set. A set nobody has used for 20 minutes is torn down, except that a repository
 * with open tasks keeps one set up. Cleanup removes every container, network and volume
 * labelled with the set's code.
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

/** a set nobody holds is torn down after this, unless it is the last one up for a repository with open tasks */
export const IDLE_TEARDOWN_MS = 20 * 60_000;
const OPEN = ["working", "waiting", "monitoring"];

const slotEnv = (slot: EnvSlot) => taskEnv(slot.runCode, slot.portBase);
const usedBases = (s: CliState) => [...(s.envPool ?? []).map((x) => x.portBase), ...s.tasks.flatMap((t) => (t.childEnvironments ?? []).map((c) => c.portBase))];

/** sets held by holders whose process is gone go back to the pool; tasks still running from before the pool become sets */
function tidy(s: CliState, now: number) {
  const pool = (s.envPool ??= []);
  for (const slot of pool) if (slot.holder && !processAlive(slot.holder.pid)) { slot.lastHolder = slot.holder.id; slot.holder = undefined; slot.lastUsedAt = now; }
  for (const t of s.tasks) {
    if (!t.portBase || !t.runCode || pool.some((x) => x.runCode === t.runCode)) continue;
    const repo = s.jobs.find((j) => j.id === t.jobId)?.repo;
    if (!repo) continue;
    // an open task gets its set back on its next claim; a finished one's set is torn down on the next sweep
    pool.push({ id: `env-${randomBytes(3).toString("hex")}`, repo, runCode: t.runCode, portBase: t.portBase, createdAt: t.envReadyAt ?? now, lastUsedAt: OPEN.includes(t.status) ? now : 0, lastHolder: t.id });
    if (t.envFilesBase === undefined) Object.assign(t, { envFilesBase: t.portBase, envFilesCode: t.runCode });
  }
  for (const t of s.tasks) if (t.portBase && !pool.some((x) => x.holder?.id === t.id)) t.portBase = undefined;
}

type Claim = { slot: EnvSlot } | { create: true } | { evict: EnvSlot } | { full: true };

/** one pass under the lock: the holder's set, a free one (its own last set first), room for a new one, or full */
function claimOnce(s: CliState, taskId: string, holderId: string, pid: number, now: number): Claim {
  tidy(s, now);
  const task = s.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} is not in the state file.`);
  const job = s.jobs.find((j) => j.id === task.jobId);
  if (!job) throw new Error(`Missing job for task ${taskId}.`);
  const pool = s.envPool!;
  const take = (slot: EnvSlot): Claim => {
    slot.holder = { id: holderId, taskId, pid, at: now };
    slot.lastUsedAt = now;
    if (holderId === taskId) Object.assign(task, { portBase: slot.portBase, runCode: slot.runCode });
    return { slot };
  };
  const mine = pool.find((x) => x.holder?.id === holderId);
  if (mine) return take(mine);
  // its own last set first, then one no other open task last used (so tasks do not shuffle sets), then the warmest
  const othersOwn = (x: EnvSlot) => !!x.lastHolder && x.lastHolder !== holderId && s.tasks.some((t) => t.id === x.lastHolder && OPEN.includes(t.status));
  const rank = (x: EnvSlot) => (x.lastHolder === holderId ? 0 : othersOwn(x) ? 2 : 1);
  const free = pool.filter((x) => x.repo === job.repo && !x.holder).sort((a, b) => rank(a) - rank(b) || b.lastUsedAt - a.lastUsedAt);
  if (free.length) return take(free[0]);
  const held = (pred: (t: Task) => boolean) => pool.filter((x) => { const t = x.holder && s.tasks.find((t) => t.id === x.holder!.taskId); return !!t && pred(t); }).length;
  if (held((t) => t.jobId === job.id) >= environmentLimit(job)) return { full: true };
  if (pool.length >= (s.capacity?.maxEnvironments ?? 16)) {
    const idle = pool.filter((x) => !x.holder).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (!idle) return { full: true };
    s.envPool = pool.filter((x) => x !== idle);
    return { evict: idle };
  }
  return { create: true };
}

/** a free port block whose key ports nothing on the machine is listening on */
async function freeBlock(): Promise<number> {
  let floor: number | undefined;
  for (let tries = 0; tries < 200; tries++) {
    const candidate = allocatePortBase(usedBases(loadState()), floor);
    if ((await Promise.all(KEY_OFFSETS.map((offset) => free(candidate + offset)))).every(Boolean)) return candidate;
    floor = candidate + PORT_BLOCK;
  }
  throw new Error("No free port block found after 200 probes.");
}

export type ClaimOptions = { holderId?: string; pid?: number; wait?: boolean; onWait?: () => void; pollMs?: number };

/**
 * The task's set of services: the one it holds, else a free one for its repository, else a new
 * one when the limits allow; otherwise it waits (or, with wait false, throws EnvironmentCapacityError).
 */
export async function claimEnvironment(taskId: string, o: ClaimOptions = {}): Promise<{ env: TaskEnv; slot: EnvSlot }> {
  const holderId = o.holderId ?? taskId, pid = o.pid ?? process.pid;
  let waited = false;
  for (;;) {
    const claim = mutateState((s) => claimOnce(s, taskId, holderId, pid, Date.now()));
    if ("slot" in claim) return { env: slotEnv(claim.slot), slot: claim.slot };
    if ("evict" in claim) { await cleanupEnvironment(claim.evict.runCode); continue; }
    if ("create" in claim) {
      const base = await freeBlock();
      const made = mutateState((s) => {
        const again = claimOnce(s, taskId, holderId, pid, Date.now());
        if (!("create" in again)) return again;
        if (usedBases(s).includes(base)) return undefined;
        const task = s.tasks.find((t) => t.id === taskId)!;
        const slot: EnvSlot = { id: `env-${randomBytes(3).toString("hex")}`, repo: s.jobs.find((j) => j.id === task.jobId)!.repo, runCode: `consort-env-${randomBytes(4).toString("hex")}`, portBase: base, createdAt: Date.now(), lastUsedAt: Date.now() };
        s.envPool!.push(slot);
        return claimOnce(s, taskId, holderId, pid, Date.now());
      });
      if (made && "slot" in made) return { env: slotEnv(made.slot), slot: made.slot };
      if (made && "evict" in made) await cleanupEnvironment(made.evict.runCode);
      if (!made || !("full" in made)) continue;
    }
    if (o.wait === false) throw new EnvironmentCapacityError(taskId);
    if (!waited) { waited = true; o.onWait?.(); }
    await new Promise((r) => setTimeout(r, o.pollMs ?? 5_000));
  }
}

/** hand the set back: it stays up for the next task on the repository until it has sat unused for 20 minutes */
export async function releaseEnvironment(holderId: string): Promise<void> {
  const slot = mutateState((s) => {
    const held = (s.envPool ?? []).find((x) => x.holder?.id === holderId);
    if (!held) return undefined;
    held.lastHolder = holderId; held.holder = undefined; held.lastUsedAt = Date.now();
    const task = s.tasks.find((t) => t.id === holderId);
    if (task) task.portBase = undefined;
    return { ...held };
  });
  // the app the task started from its worktree (up.sh) is its own; the services stay for the next task
  if (slot) await stopAppProcesses(slot.portBase).catch(() => undefined);
}

/** the app ports of a block (base+0..9): whatever listens there, other than Docker's own port forwarding */
async function stopAppProcesses(base: number) {
  const out = await run("lsof", ["-nP", "-Fpc", ...Array.from({ length: 10 }, (_, i) => `-iTCP:${base + i}`), "-sTCP:LISTEN"], { timeout: 10_000 }).then((r) => r.stdout, () => "");
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("c") && pid && pid !== process.pid && !/docker|vpnkit|com\.docker/i.test(line)) { try { process.kill(pid, "SIGTERM"); } catch {} }
  }
}

/**
 * The daemon's sweep: sets nobody has used for 20 minutes are torn down, except that a repository
 * with open tasks keeps its most recently used set; returns the run codes removed.
 */
export async function reapIdleEnvironments(now = Date.now()): Promise<string[]> {
  const doomed = mutateState((s) => {
    tidy(s, now);
    const pool = s.envPool!;
    const idle = (x: EnvSlot) => !x.holder && now - x.lastUsedAt >= IDLE_TEARDOWN_MS;
    const out: EnvSlot[] = [];
    for (const repo of new Set(pool.map((x) => x.repo))) {
      const sets = pool.filter((x) => x.repo === repo);
      const stale = sets.filter(idle).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
      // a repository with open tasks keeps one set up: the most recently used, when no other is in use or fresh
      const repoOpen = s.tasks.some((t) => OPEN.includes(t.status) && s.jobs.find((j) => j.id === t.jobId)?.repo === repo);
      out.push(...(repoOpen && stale.length === sets.length ? stale.slice(1) : stale));
    }
    s.envPool = pool.filter((x) => !out.includes(x));
    return out;
  });
  for (const slot of doomed) await cleanupEnvironment(slot.runCode);
  return doomed.map((x) => x.runCode);
}

/**
 * The worktree's environment files (.consort/env, ENV.md) were written for another set: point them
 * at this one by swapping the run code and every port of the old block for the same offset in the new.
 */
export function retargetEnvFiles(worktree: string, from: { runCode: string; portBase: number }, to: { runCode: string; portBase: number }): number {
  if (from.runCode === to.runCode && from.portBase === to.portBase) return 0;
  const files: string[] = [];
  const walk = (dir: string) => { for (const n of readdirSync(dir)) { const f = join(dir, n); if (statSync(f).isDirectory()) walk(f); else files.push(f); } };
  if (existsSync(join(worktree, ENV_DIR))) walk(join(worktree, ENV_DIR));
  if (existsSync(join(worktree, ENV_DOC))) files.push(join(worktree, ENV_DOC));
  let changed = 0;
  for (const f of files) {
    if (statSync(f).size > 1 << 20) continue;
    const text = readFileSync(f, "utf8");
    const next = text.split(from.runCode).join(to.runCode)
      .replace(/(?<![\d])(\d{4,5})(?![\d])/g, (m) => { const n = Number(m); return n >= from.portBase && n < from.portBase + PORT_BLOCK ? String(to.portBase + n - from.portBase) : m; });
    if (next !== text) { writeFileSync(f, next); changed++; }
  }
  return changed;
}

/** the run code and port block the worktree's .env.consort was written for, when it names them */
export function filesBlock(worktree: string, runCode: string): { runCode: string; portBase: number } | undefined {
  const f = join(worktree, ENV_DIR, ".env.consort");
  if (!existsSync(f)) return undefined;
  const ports = [...readFileSync(f, "utf8").matchAll(/(?<!\d)(\d{5})(?!\d)/g)].map((m) => Number(m[1])).filter((n) => n >= PORT_FLOOR && n < 60_000);
  return ports.length ? { runCode, portBase: Math.floor(Math.min(...ports) / PORT_BLOCK) * PORT_BLOCK } : undefined;
}

/** claim, and when the worktree's files point at another set, retarget them; logs what moved */
export async function claimForTask(task: Pick<Task, "id" | "worktree">, o: ClaimOptions & { log?: (line: string) => void } = {}): Promise<TaskEnv> {
  const { env, slot } = await claimEnvironment(task.id, o);
  const latest = loadState().tasks.find((t) => t.id === task.id);
  let files = latest?.envReadyAt && latest.envFilesBase !== undefined && latest.envFilesCode ? { runCode: latest.envFilesCode, portBase: latest.envFilesBase } : undefined;
  // set up before the pool kept a record: read the block from the files, else set the environment up again
  if (latest?.envReadyAt && !files) {
    files = latest.runCode ? filesBlock(task.worktree, latest.runCode) : undefined;
    if (!files) { mutateState((s) => { const t = s.tasks.find((x) => x.id === task.id); if (t) t.envReadyAt = undefined; }); o.log?.("environment files predate the pool and name no port block; setting the environment up again"); }
  }
  if (files && (files.runCode !== slot.runCode || files.portBase !== slot.portBase)) {
    const n = existsSync(task.worktree) ? retargetEnvFiles(task.worktree, files, slot) : 0;
    o.log?.(`environment moved to ${slot.runCode} on ports ${slot.portBase}-${slot.portBase + PORT_BLOCK - 1} (${n} file(s) updated)`);
  }
  if (slot.lastHolder && slot.lastHolder !== task.id) o.log?.(`environment ${slot.runCode} was last used by another task; its data may need a reset`);
  mutateState((s) => { const t = s.tasks.find((x) => x.id === task.id); if (t) Object.assign(t, { envFilesBase: slot.portBase, envFilesCode: slot.runCode }); });
  return env;
}

/** a parallel writer claims a set of its own for the action, then hands it back; full capacity throws so the ticket runs serially */
export async function withChildEnvironment<T>(taskId: string, childId: string, action: (env: TaskEnv) => Promise<T>): Promise<T> {
  const holderId = `${taskId}/${childId}`;
  const { env } = await claimEnvironment(taskId, { holderId, wait: false });
  try { return await action(env); }
  finally { await releaseEnvironment(holderId); }
}
