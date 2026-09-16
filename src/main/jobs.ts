import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Job } from "../shared/types";

// ponytail: background shell jobs with streamed output, not a PTY; add node-pty + xterm if curses apps matter
const MAX_OUT = 200_000;
const jobs = new Map<string, Job & { proc?: ChildProcess }>();
let notify: (jobs: Job[]) => void = () => {};
let timer: NodeJS.Timeout | undefined;

export const onJobs = (cb: typeof notify) => (notify = cb);
export const list = (): Job[] => [...jobs.values()].map(({ proc: _p, ...j }) => j);
const flush = () => { clearTimeout(timer); timer = undefined; notify(list()); };
const schedule = () => { if (!timer) timer = setTimeout(flush, 120); };

export function start(scopeId: string, cwd: string, cmd: string, termId: string): string {
  const id = randomUUID();
  const proc = spawn("/bin/zsh", ["-lc", cmd], { cwd, detached: true, env: { ...process.env, FORCE_COLOR: "0", TERM: "dumb" } });
  const job: Job & { proc?: ChildProcess } = { id, scopeId, termId, cwd, cmd, out: "", status: "running", startedAt: Date.now(), proc };
  jobs.set(id, job);
  const append = (b: Buffer) => { job.out = (job.out + b.toString()).slice(-MAX_OUT); schedule(); };
  proc.stdout?.on("data", append);
  proc.stderr?.on("data", append);
  proc.on("error", (e) => { job.out += `\n[spawn error] ${e.message}`; job.status = "exited"; job.code = -1; flush(); });
  proc.on("close", (code) => { job.status = "exited"; job.code = code ?? -1; job.proc = undefined; flush(); });
  flush();
  return id;
}

export function stop(id: string) {
  const j = jobs.get(id);
  if (!j?.proc?.pid) return;
  try { process.kill(-j.proc.pid, "SIGTERM"); } catch { j.proc.kill("SIGTERM"); }
  setTimeout(() => { if (j.status === "running" && j.proc?.pid) { try { process.kill(-j.proc.pid, "SIGKILL"); } catch {} } }, 3000);
}

export function write(id: string, text: string) {
  jobs.get(id)?.proc?.stdin?.write(text);
}

export function seen(id: string) {
  const j = jobs.get(id);
  if (j && !j.seen) { j.seen = true; schedule(); }
}

export function remove(id: string) {
  const j = jobs.get(id);
  if (j?.status === "running") stop(id);
  jobs.delete(id);
  flush();
}

export const stopAll = () => { for (const id of jobs.keys()) stop(id); };
