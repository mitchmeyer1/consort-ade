/**
 * This machine at a glance for the Slack monitor's System box: Consort's database sets (the env pool) and worktrees,
 * running Docker containers, CPU, memory and disk. Numbers are rounded so the monitor and its picture change only
 * when something moves, not on every pass.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cpus, freemem, loadavg, totalmem, type as osType } from 'node:os';
import type { SystemSnapshot } from '../shared/slackMonitor.ts';
import { HOME, WORK_DIR, type CliState } from './state.ts';

const GB = 1024 ** 3;
const quiet = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return undefined; } };

/** One reading per daemon pass, kept 30 minutes in a file so a daemon restart keeps the charts. */
type Sample = { at: number; cpu: number; memory: number };
const HISTORY_FILE = join(HOME, 'system-history.json'), WINDOW = 30 * 60_000;
export const BUCKET_MS = 2 * 60_000, BUCKETS = WINDOW / BUCKET_MS;
let history: Sample[] | undefined;
function record(sample: Sample): Sample[] {
  if (!history) { try { history = (JSON.parse(readFileSync(HISTORY_FILE, 'utf8')) as Sample[]).filter((x) => Number.isFinite(x.at)); } catch { history = []; } }
  history = [...history.filter((x) => x.at > sample.at - WINDOW - BUCKET_MS), sample];
  try { writeFileSync(HISTORY_FILE, JSON.stringify(history)); } catch { /* the charts just start over */ }
  return history;
}
/**
 * The last 30 minutes as 15 two-minute bars, oldest first, each the average of its readings rounded to 5%; null where the
 * daemon took none. Only finished two-minute spans count, so the bars change at most every two minutes.
 */
export function historyBars(samples: Sample[], now: number, pick: (s: Sample) => number): (number | null)[] {
  const end = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  return Array.from({ length: BUCKETS }, (_, i) => {
    const from = end - (BUCKETS - i) * BUCKET_MS, inside = samples.filter((s) => s.at >= from && s.at < from + BUCKET_MS);
    return inside.length ? Math.round(inside.reduce((a, s) => a + pick(s), 0) / inside.length / 5) * 5 : null;
  });
}

let lastTimes: { idle: number; total: number } | undefined;
/** Busy share of all cores since the last call (the daemon calls once a pass); the 1-minute load on the first call. */
function cpuPercent(): number {
  const all = cpus(), now = all.reduce((sum, c) => { const t = Object.values(c.times).reduce((a, b) => a + b, 0); return { idle: sum.idle + c.times.idle, total: sum.total + t }; }, { idle: 0, total: 0 });
  const prev = lastTimes; lastTimes = now;
  const pct = prev && now.total > prev.total ? 100 * (1 - (now.idle - prev.idle) / (now.total - prev.total)) : (100 * loadavg()[0]!) / Math.max(1, all.length);
  return Math.max(0, Math.min(100, pct));
}

/** Memory in use as Activity Monitor counts it on macOS (active, wired, compressed); elsewhere total less free. */
function memoryUsed(): number {
  if (process.platform === 'darwin') {
    const out = quiet('vm_stat', []);
    const page = Number(out?.match(/page size of (\d+) bytes/)?.[1]);
    const pages = (name: string) => Number(out?.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1] ?? NaN);
    const used = (pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page;
    if (Number.isFinite(used) && used > 0) return used;
  }
  return totalmem() - freemem();
}

let machine: string | undefined;
/** `Apple M3 Max · 14 cores · macOS 26.4`, read once. */
function machineLine(): string {
  if (machine) return machine;
  const all = cpus(), version = process.platform === 'darwin' ? quiet('sw_vers', ['-productVersion'])?.trim() : undefined;
  return (machine = [all[0]?.model.trim() || 'unknown CPU', `${all.length} cores`, version ? `macOS ${version}` : osType()].join(' · '));
}

export function systemSnapshot(state: Pick<CliState, 'envPool'>, now = Date.now()): SystemSnapshot {
  const pool = state.envPool ?? [];
  const cpu = cpuPercent(), used = memoryUsed(), total = totalmem();
  const samples = record({ at: now, cpu, memory: (100 * used) / total });
  // A task's worktree, plus the parallel writers' worktrees kept in its hidden `.parallel-<name>` folder.
  const dirs = (path: string) => (existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()) : []);
  const worktrees = dirs(WORK_DIR).reduce((n, d) => n + (d.name.startsWith('.parallel-') ? dirs(join(WORK_DIR, d.name)).length : 1), 0);
  const containers = quiet('docker', ['ps', '-q'])?.split('\n').filter(Boolean).length;
  let disk: { free: number; total: number } | undefined;
  try { const s = statfsSync(HOME); disk = { free: Math.round((s.bavail * s.bsize) / GB), total: Math.round((s.blocks * s.bsize) / GB) }; } catch { /* no disk reading */ }
  return {
    databases: pool.length, databasesInUse: pool.filter((x) => x.holder).length, worktrees, ...(containers === undefined ? {} : { containers }),
    cpu: Math.round(cpu / 5) * 5, memoryUsed: Math.round(used / GB), memoryTotal: Math.round(total / GB),
    cpuHistory: historyBars(samples, now, (s) => s.cpu), memoryHistory: historyBars(samples, now, (s) => s.memory),
    ...(disk ? { diskFree: Math.round(disk.free / 10) * 10, diskTotal: disk.total } : {}), machine: machineLine(),
  };
}
