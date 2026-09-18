import { app } from "electron";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { codexBin, loginEnv } from "./auth";
import { claudeUsageFrom, codexUsageFrom, type ConnectorUsage } from "../shared/usage";
import type { ApiKey } from "../shared/types";

export type Probe = (key: ApiKey) => Promise<ConnectorUsage>;

const TTL = 60_000;
const PROBE_TIMEOUT = 20_000;

/**
 * Plan usage per connector, fetched on demand (Settings opening, the refresh button) and kept
 * for a minute so reopening the panel does not respawn a CLI each time. Probes are injected so
 * the caching can be exercised without processes.
 */
export function createUsageReader(probes: Record<ApiKey["provider"], Probe>, ttl = TTL) {
  const cache = new Map<string, ConnectorUsage>();
  const inflight = new Map<string, Promise<ConnectorUsage>>();
  const read = (key: ApiKey, opts: { force?: boolean; now?: number } = {}): Promise<ConnectorUsage> => {
    const now = opts.now ?? Date.now();
    const hit = cache.get(key.id);
    if (hit && !opts.force && now - hit.at < ttl) return Promise.resolve(hit);
    const running = inflight.get(key.id);
    if (running) return running;
    if (key.auth !== "login") {
      const u: ConnectorUsage = { keyId: key.id, at: now, windows: [], unavailable: "Billed per token — an API key has no plan limits to meter." };
      cache.set(key.id, u);
      return Promise.resolve(u);
    }
    const p = probes[key.provider](key)
      .catch((e): ConnectorUsage => ({ keyId: key.id, at: now, windows: [], unavailable: describe(e) }))
      .then((u) => { cache.set(key.id, u); return u; })
      .finally(() => inflight.delete(key.id));
    inflight.set(key.id, p);
    return p;
  };
  return { read, forget: (keyId: string) => cache.delete(keyId) };
}

const describe = (e: unknown) => {
  const msg = String((e as Error)?.message ?? e);
  if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return "CLI not found.";
  if (/timed out/i.test(msg)) return "The CLI did not answer in time.";
  return `Usage unavailable: ${msg.split("\n")[0]}`;
};

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${what} timed out`)), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });

const envWithout = (k: string) => { const { [k]: _drop, ...rest } = process.env; return rest as Record<string, string | undefined>; };
// a bare directory for probe sessions, so no project settings or hooks load
const probeDir = () => { const d = join(app.getPath("userData"), "usage-probe"); mkdirSync(d, { recursive: true }); return d; };

/**
 * Claude answers `/usage` over its control channel, which needs a live CLI process; the prompt
 * stream never yields, so the process idles at init, answers, and is closed — no model call.
 */
export const probeClaude: Probe = async (key) => {
  const ac = new AbortController();
  async function* idle() { await new Promise<void>((r) => ac.signal.addEventListener("abort", () => r(), { once: true })); }
  const q = query({ prompt: idle(), options: { cwd: probeDir(), abortController: ac, env: { ...envWithout("ANTHROPIC_API_KEY"), ...loginEnv(key) } } });
  try {
    const raw = await withTimeout(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), PROBE_TIMEOUT, "Claude usage");
    return claudeUsageFrom(key.id, raw as Parameters<typeof claudeUsageFrom>[1], Date.now());
  } finally {
    ac.abort();
    try { q.close(); } catch {}
  }
};

/** Codex serves the same numbers its TUI shows over the app-server JSON-RPC (`account/rateLimits/read`). */
export const probeCodex: Probe = async (key) => {
  const child = spawn(codexBin(), ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: { ...envWithout("OPENAI_API_KEY"), ...loginEnv(key) } as NodeJS.ProcessEnv });
  const waits = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  let id = 0, buf = "";
  const spawned = new Promise<void>((res, rej) => { child.once("spawn", () => res()); child.once("error", rej); });
  const exited = new Promise<never>((_, rej) => child.once("exit", (code) => rej(new Error(`codex app-server exited (${code ?? "signal"})`))));
  child.stdout.on("data", (d) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let m: any;
      try { m = JSON.parse(line); } catch { continue; }
      const w = typeof m?.id === "number" ? waits.get(m.id) : undefined;
      if (!w) continue;
      waits.delete(m.id);
      m.error ? w.rej(new Error(m.error.message ?? "app-server error")) : w.res(m.result);
    }
  });
  const request = (method: string, params: unknown) =>
    Promise.race([exited, new Promise<unknown>((res, rej) => { const i = ++id; waits.set(i, { res, rej }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); })]);
  const notify = (method: string) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  try {
    await withTimeout(spawned, PROBE_TIMEOUT, "Codex start");
    await withTimeout(request("initialize", { clientInfo: { name: "consort", title: "Consort", version: app.getVersion() }, capabilities: null }), PROBE_TIMEOUT, "Codex initialize");
    notify("initialized");
    const [limits, account] = await withTimeout(Promise.all([
      request("account/rateLimits/read", { excludeResetCreditDetails: true }),
      request("account/read", {}).catch(() => null),
    ]), PROBE_TIMEOUT, "Codex usage");
    return codexUsageFrom(key.id, limits as Parameters<typeof codexUsageFrom>[1], account as Parameters<typeof codexUsageFrom>[2], Date.now());
  } finally {
    child.kill();
  }
};

export const usage = createUsageReader({ claude: probeClaude, codex: probeCodex });
