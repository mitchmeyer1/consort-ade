import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, LOG_DIR, loadState } from "./state.ts";

/**
 * The daemon as a background process: `run -d` starts it detached with its output in a log
 * and its pid in a file, `stop` ends it, and the dashboard reads the pid file to say whether
 * it is up. Workers are separate processes; stopping the daemon leaves them running, and a
 * daemon started later adopts them (it restarts the ones that died).
 */
export const DAEMON_PID = join(HOME, "daemon.pid");
export const DAEMON_LOG = join(LOG_DIR, "daemon.log");

/** EPERM means the process exists but this caller cannot signal it; only ESRCH means absent. */
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

/** the running daemon's pid, or undefined; a stale pid file is removed */
export function daemonPid(): number | undefined {
  if (!existsSync(DAEMON_PID)) return undefined;
  const pid = Number(readFileSync(DAEMON_PID, "utf8").trim());
  if (pid && alive(pid)) return pid;
  try { rmSync(DAEMON_PID); } catch {}
  return undefined;
}

/** the foreground daemon records itself too, so `stop` and `view` know about it */
export function recordDaemon(): void {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(DAEMON_PID, String(process.pid), { mode: 0o600 });
  const clear = () => { try { if (readFileSync(DAEMON_PID, "utf8").trim() === String(process.pid)) rmSync(DAEMON_PID); } catch {} };
  process.on("exit", clear);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { clear(); process.exit(0); });
}

/** start `node <self> run` detached; resolves to its pid */
export function startDetached(self: string): number {
  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(DAEMON_LOG, "a");
  const child = spawn(process.execPath, [self, "run"], { detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
  writeFileSync(DAEMON_PID, String(child.pid), { mode: 0o600 });
  return child.pid!;
}

/** stop the daemon; with `all`, the worker processes too (their tasks stay as they are and resume on the next `run`) */
export function stopDaemon(opts: { all?: boolean } = {}): { daemon?: number; workers: number[] } {
  const pid = daemonPid();
  if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} try { rmSync(DAEMON_PID); } catch {} }
  const workers: number[] = [];
  if (opts.all) for (const t of loadState().tasks) if (t.pid && alive(t.pid)) { try { process.kill(t.pid, "SIGTERM"); workers.push(t.pid); } catch {} }
  return { daemon: pid, workers };
}
