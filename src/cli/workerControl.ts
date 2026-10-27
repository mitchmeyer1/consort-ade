/** Coordinate deliberate worker stops with daemon restarts and late child exit callbacks. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadState, mutateState, processAlive, updateTask, type CliState, type Task } from "./state";
import { notifyTask } from "./lifecycle";
import { releaseEnvironment } from "./environment";

export function canStartWorker(task: Task, workerAlive: boolean, now = Date.now()): boolean {
  return ["working", "waiting", "monitoring"].includes(task.status) && !workerAlive && !(task.workerStop && task.workerStop.holdUntil > now);
}
export function requestWorkerStop(taskId: string, pid: number, command: string): void {
  const request = { pid, command, requesterPid: process.pid, at: Date.now(), holdUntil: Date.now() + 30_000 };
  updateTask(taskId, { workerStop: request });
  console.log(`${new Date().toISOString()} ${command} pid ${process.pid} requested SIGTERM for worker ${pid} task ${taskId}`);
}
export function workerStopMessage(task: Task, pid: number, signal: string): string {
  const request = task.workerStop;
  return request?.pid === pid
    ? `Stopped for ${request.command} (requested by process ${request.requesterPid}; ${signal}). Progress saved.`
    : `Worker received ${signal} from outside Consort's recorded stop commands. Progress saved; the daemon restarts it if running.`;
}
export async function handleWorkerExit(taskId: string, pid: number, code: number | null, signal: string | null): Promise<void> {
  const task = loadState().tasks.find(t => t.id === taskId);
  // A reboot can already have installed a replacement. Its state belongs to that worker.
  if (!task || task.pid !== pid) return;
  const finished = ["ready", "done", "released", "failed"].includes(task.status);
  const restarts = (task.restarts ?? 0) + 1;
  updateTask(taskId, { pid: undefined, ...(!finished && (code || signal) && task.workerStop?.pid !== pid ? {
    restarts, note: `worker exited ${signal ?? code}; restart ${restarts}`,
    activity: restarts >= 4 ? "worker repeatedly exited; restarting to ask Slack for help" : `crashed (${signal ?? code}); restarting`,
  } : {}) });
  if (!finished && task.workerStop?.pid !== pid) await notifyTask(taskId, "stopped", `Worker exited (${signal ?? code}); restarting.`);
}

/** a ticket the owner killed: scanners skip it until `tasks retry` brings it back */
export const isKilled = (s: Pick<CliState, "killedTickets">, jobId: string, ticketId: string) => (s.killedTickets ?? []).some((k) => k.jobId === jobId && k.ticketId === ticketId);

export type KillDeps = {
  signal: (pid: number, sig: NodeJS.Signals) => void;
  alive: (pid: number) => boolean;
  /** the agent processes (claude, codex) the worker started */
  children: (pid: number) => Promise<number[]>;
  wait: (ms: number) => Promise<void>;
  notify: (taskId: string, text: string) => Promise<void>;
  release: (holderId: string) => Promise<void>;
};
const defaultDeps: KillDeps = {
  signal: (pid, sig) => { try { process.kill(pid, sig); } catch {} },
  alive: processAlive,
  children: (pid) => promisify(execFile)("pgrep", ["-P", String(pid)]).then((r) => r.stdout.split("\n").filter(Boolean).map(Number), () => []),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  notify: (taskId, text) => notifyTask(taskId, "stopped", text),
  release: releaseEnvironment,
};

/**
 * `tasks kill`: the owner takes the ticket over. The worker and its agent processes stop for good
 * (SIGTERM, then SIGKILL after 20 seconds), the daemon never restarts it, no scanner claims the
 * ticket again, its services go back to the pool, and the worktree, branch and PR stay for the owner.
 */
export async function killTask(taskId: string, deps: KillDeps = defaultDeps): Promise<Task> {
  const task = mutateState((s) => {
    const t = s.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error(`No task ${taskId}.`);
    Object.assign(t, { status: "released", finishedAt: Date.now(), note: "killed: you are handling it", activity: "killed by you; handle it manually", pendingQuestion: undefined });
    if (!isKilled(s, t.jobId, t.ticket.id)) (s.killedTickets ??= []).push({ jobId: t.jobId, ticketId: t.ticket.id, at: Date.now() });
    return { ...t };
  });
  const pid = task.pid;
  if (pid && deps.alive(pid)) {
    requestWorkerStop(taskId, pid, "consort-cli tasks kill");
    const agents = await deps.children(pid);
    deps.signal(pid, "SIGTERM");
    for (let waited = 0; waited < 20_000 && deps.alive(pid); waited += 500) await deps.wait(500);
    for (const child of [...agents, ...(deps.alive(pid) ? await deps.children(pid) : [])]) if (deps.alive(child)) deps.signal(child, "SIGKILL");
    if (deps.alive(pid)) deps.signal(pid, "SIGKILL");
  }
  // the worker may have saved on its way out: the kill stands
  updateTask(taskId, { status: "released", pid: undefined, note: "killed: you are handling it", activity: "killed by you; handle it manually" });
  await deps.release(taskId);
  for (const held of (loadState().envPool ?? []).filter((x) => x.holder?.taskId === taskId)) await deps.release(held.holder!.id);
  updateTask(taskId, { environmentReservation: undefined, childEnvironments: [] });
  const pr = task.feature.prs[0] ?? (task.kind === "review" ? task.review?.url : undefined);
  await deps.notify(taskId, `Killed by you; you are handling it from here. Consort stopped its agents and will not pick this ticket up again.${task.kind === "review" ? "" : ` Branch \`${task.branch}\`.`}${pr ? ` PR: ${pr}` : ""}`).catch(() => undefined);
  return loadState().tasks.find((x) => x.id === taskId) ?? task;
}