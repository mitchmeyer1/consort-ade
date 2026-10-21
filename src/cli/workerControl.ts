/** Coordinate deliberate worker stops with daemon restarts and late child exit callbacks. */
import { loadState, updateTask, type Task } from "./state";
import { notifyTask } from "./lifecycle";

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
