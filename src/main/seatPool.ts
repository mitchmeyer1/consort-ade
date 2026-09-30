import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseChooser, type SeatPool } from "../shared/seatPool";
import type { State } from "../shared/types";

export const POOL_KEY_ID = "pool-claude";
/** where the chooser lives on the machine this was built for; Settings can point elsewhere */
export const DEFAULT_CHOOSER = join(homedir(), "command-center", "operating-model", "bin", "claude-chooser.sh");
export const DEFAULT_SEAT = join(homedir(), ".claude");

// A Finder-launched app inherits launchd's bare PATH; the chooser shells out to python3 and `security`.
const PATH = [...new Set([...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(Boolean))].join(":");
const lastLine = (s: unknown) => String(s ?? "").trim().split("\n").pop() ?? "";

export type ChooserOpts = { exclude?: string[]; maxAge?: number; model?: string };
export type RunChooser = (command: string, opts?: ChooserOpts) => Promise<SeatPool>;

/**
 * One `--json` read of the pool. `--max-age` lets the chooser reuse its own copy of a recent live
 * read, since the usage endpoint 429s when polled every few seconds. Exit 4 (every seat excluded)
 * still prints JSON, with no pick.
 */
export const runChooser: RunChooser = (command, opts = {}) => {
  const args = ["--json", "--max-age", String(opts.maxAge ?? 120), ...(opts.model ? ["--model", opts.model] : []), ...(opts.exclude ?? []).flatMap((d) => ["--exclude", d])];
  return new Promise((resolve, reject) => {
    execFile(command, args, { env: { ...process.env, PATH }, timeout: 60_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      try { resolve(parseChooser(String(stdout), Date.now())); }
      catch { reject(new Error(lastLine(stderr) || (error as Error | null)?.message || "the seat chooser printed nothing")); }
    });
  });
};

/**
 * The pool connector exists once a chooser is set, and the first launch on a machine that has one at the
 * usual path sets it. It becomes the default Claude connector when it first appears; clearing the chooser
 * later leaves the connector in place, so chats already on it keep working on their last seat.
 */
export function ensurePoolKey(state: State, chooser = DEFAULT_CHOOSER) {
  if (state.seatChooser === undefined && existsSync(chooser)) state.seatChooser = chooser;
  if (!state.seatChooser || state.keys.some((k) => k.id === POOL_KEY_ID)) return;
  const login = state.keys.find((k) => k.id === "login-claude");
  state.keys.splice(login ? state.keys.indexOf(login) + 1 : 0, 0, { id: POOL_KEY_ID, provider: "claude", name: "Claude seat pool", auth: "login", pool: true, ...(login?.defaultModel ? { defaultModel: login.defaultModel } : {}) });
  if (!state.defaultKeyId || state.defaultKeyId === "login-claude") state.defaultKeyId = POOL_KEY_ID;
}

/** Seats share `projects/` by symlink, so a session made on one resumes on another; this checks that it will. */
export function sessionOnSeat(configDir: string, sessionId: string) {
  const root = join(configDir, "projects");
  try { return readdirSync(root).some((p) => existsSync(join(root, p, `${sessionId}.jsonl`))); }
  catch { return false; }
}

/**
 * Keeps a pool snapshot fresh for the seat meters: every few minutes, and on demand after a
 * limit or a switch. Failures keep the last good seats and say why.
 */
export function createSeatMonitor(deps: { command: () => string | undefined; publish: (pool: SeatPool) => void; last: () => SeatPool | undefined; run?: RunChooser; interval?: number }) {
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<SeatPool | undefined> | undefined;
  const refresh = (maxAge = 150): Promise<SeatPool | undefined> => {
    const command = deps.command();
    if (!command) return Promise.resolve(undefined);
    inflight ??= (deps.run ?? runChooser)(command, { maxAge })
      .catch((e): SeatPool => ({ ...(deps.last() ?? { at: 0, pickBlocked: false, seats: [] }), error: String((e as Error).message ?? e) }))
      .then((pool) => { deps.publish(pool); return pool; })
      .finally(() => { inflight = undefined; });
    return inflight;
  };
  const stop = () => { if (timer) clearInterval(timer); timer = undefined; };
  const start = () => { stop(); void refresh(); timer = setInterval(() => void refresh(), deps.interval ?? 180_000); };
  return { refresh, start, stop };
}
