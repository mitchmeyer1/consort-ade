import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { claudeUsageFrom, codexUsageFrom, type ConnectorUsage } from "../shared/usage.ts";
import { binaryFor, envFor } from "./agent";
import { HOME, type Account } from "./state";

/**
 * Plan usage per account for `consort-cli view`: the same meters the providers' own tools
 * show (5-hour, weekly, per-model). Claude answers over the SDK's control channel from an
 * idle CLI process, Codex over its app-server; neither makes a model call. An API key has no
 * plan to meter and says so.
 */
const PROBE_TIMEOUT = 20_000;
const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  new Promise<T>((res, rej) => { const t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });
const probeDir = () => { const d = join(HOME, "usage-probe"); mkdirSync(d, { recursive: true }); return d; };

async function probeClaude(account: Account): Promise<ConnectorUsage> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const ac = new AbortController();
  async function* idle() { await new Promise<void>((r) => ac.signal.addEventListener("abort", () => r(), { once: true })); }
  const q = query({ prompt: idle(), options: { cwd: probeDir(), pathToClaudeCodeExecutable: binaryFor("claude"), abortController: ac, env: envFor(account) as Record<string, string> } });
  try {
    const raw = await withTimeout((q as any).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), PROBE_TIMEOUT, "Claude usage");
    return claudeUsageFrom(account.id, raw as Parameters<typeof claudeUsageFrom>[1], Date.now());
  } finally { ac.abort(); try { q.close(); } catch {} }
}

async function probeCodex(account: Account): Promise<ConnectorUsage> {
  const child = spawn(binaryFor("codex"), ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: envFor(account) as NodeJS.ProcessEnv });
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
      let m: any; try { m = JSON.parse(line); } catch { continue; }
      const w = typeof m?.id === "number" ? waits.get(m.id) : undefined;
      if (!w) continue;
      waits.delete(m.id);
      m.error ? w.rej(new Error(m.error.message ?? "app-server error")) : w.res(m.result);
    }
  });
  const request = (method: string, params: unknown) => Promise.race([exited, new Promise<unknown>((res, rej) => { const i = ++id; waits.set(i, { res, rej }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); })]);
  try {
    await withTimeout(spawned, PROBE_TIMEOUT, "Codex start");
    await withTimeout(request("initialize", { clientInfo: { name: "consort-cli", title: "Consort", version: "0" }, capabilities: null }), PROBE_TIMEOUT, "Codex initialize");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    const [limits, account_] = await withTimeout(Promise.all([request("account/rateLimits/read", { excludeResetCreditDetails: true }), request("account/read", {}).catch(() => null)]), PROBE_TIMEOUT, "Codex usage");
    return codexUsageFrom(account.id, limits as Parameters<typeof codexUsageFrom>[1], account_ as Parameters<typeof codexUsageFrom>[2], Date.now());
  } finally { child.kill(); }
}

export async function readUsage(account: Account): Promise<ConnectorUsage> {
  const at = Date.now();
  if (account.auth !== "login") return { keyId: account.id, at, windows: [], unavailable: "API key: billed per token, no plan meters" };
  return (account.provider === "claude" ? probeClaude(account) : probeCodex(account))
    .catch((e): ConnectorUsage => ({ keyId: account.id, at, windows: [], unavailable: (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "CLI not found" : /timed out/i.test(String((e as Error)?.message)) ? "no answer from the CLI" : String((e as Error)?.message ?? e).split("\n")[0] }));
}

/** every account's usage, probed in parallel; the view calls this once a minute */
export const readAllUsage = async (accounts: Account[]): Promise<Map<string, ConnectorUsage>> => new Map((await Promise.all(accounts.map(async (a) => [a.id, await readUsage(a)] as const))));
