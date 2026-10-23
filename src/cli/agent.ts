import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { cliBinary, type Deps as RuntimeDeps } from "../main/cliRuntime";
import type { Provider } from "../shared/types";
import { HOME, type Account } from "./state";
import { recordTurn, sumUsage, type TurnOutcome, type TurnRecord, type TurnTrace } from "./telemetry";
import { hostname } from "node:os";
import { isCodexLimitText, isUsageLimitText, limitFromRateEvent, type LimitHit } from "../shared/seatPool.ts";
import type { TurnUsage } from "../shared/headless.ts";
import { codexEffort, type EffortLevel } from "../shared/cliTurnPolicy.ts";
import type { HookCallback, SettingSource } from "@anthropic-ai/claude-agent-sdk";

/**
 * One agent turn, headless: Claude Code through the agent SDK, Codex through its SDK, each on the
 * account's own credentials (a CLI login's config dir, or an API key) and on the bundled or
 * downloaded CLI binary (main/cliRuntime.ts, with this process's own paths). A turn resolves to
 * the agent's final text and the session id, so the next turn can continue the conversation.
 */

const run = promisify(execFile);

/** this package's root, whether running from out/cli/index.js or straight from src/cli */
export const packageRoot = () => fileURLToPath(new URL("../../", import.meta.url));

export const runtimeDeps: RuntimeDeps = {
  root: () => join(HOME, "cli"),
  appPath: packageRoot,
  fetch: (...a) => fetch(...a),
  exec: (cmd, args) => run(cmd, args, { timeout: 20_000, maxBuffer: 1 << 20 }).then((r) => r.stdout),
  platform: process.platform,
  arch: process.arch,
  now: () => Date.now(),
};

export const binaryFor = (provider: Provider): string => {
  const bin = cliBinary(provider, runtimeDeps);
  if (!bin) throw new Error(`No ${provider === "claude" ? "Claude Code" : "Codex"} binary for ${process.platform}-${process.arch}. Run \`pnpm install\` on this machine (the platform package is an optional dependency) or \`consort-cli cli update\`.`);
  return bin;
};

export type TurnOptions = { /** labels for the telemetry log; without it the turn is not recorded */ trace?: TurnTrace; cwd: string; prompt: string; model: string; account: Account; resume?: string; maxTurns?: number; onText?: (t: string) => void; signal?: AbortSignal; readOnly?: boolean; /** no web search or fetch, so what the turn read never leaves this machine except in its reply */ offline?: boolean; /** where Claude Code loads settings, CLAUDE.md and MCP servers from; a project info resource reader skips the notes repo's own */ settingSources?: SettingSource[]; effort?: EffortLevel; delegateModel?: string; maxDelegates?: number; /** the task's own ports and Docker names, on top of the process env */ env?: Record<string, string> };
export type Turn = { text: string; sessionId?: string; error?: string; limit?: LimitHit; /** what the turn spent, per model (Claude Code prices its own; Codex gives tokens only) */ usage?: TurnUsage[] };

export const envFor = (account: Account, extra: Record<string, string> = {}): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY;
  if (account.auth === "key" && account.apiKey) env[account.provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"] = account.apiKey;
  if (account.auth === "login" && account.configDir) env[account.provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] = account.configDir;
  return env;
};

/** the turn in flight, so a stop signal can end the agent process instead of orphaning it */
const inFlight = new Set<() => void>();
export const stopAgents = () => { for (const stop of inFlight) { try { stop(); } catch {} } inFlight.clear(); };

export async function runTurn(o: TurnOptions): Promise<Turn> {
  const at = Date.now();
  let res: Turn | undefined;
  try {
    res = await (o.account.provider === "claude" ? runClaude(o) : runCodex(o));
    return res;
  } finally {
    // every turn lands in the telemetry log, whatever happened to it (cli/telemetry.ts)
    if (o.trace) {
      const spent = sumUsage(res?.usage);
      const outcome: TurnOutcome = res?.limit ? "limit" : o.signal?.aborted ? (o.trace.reason ?? "aborted") : !res ? "error" : res.error ? "error" : "ok";
      recordTurn(HOME, { ...o.trace, reason: undefined, at, durationMs: Date.now() - at, provider: o.account.provider, account: o.account.name, model: o.model, resumed: !!o.resume, outcome, error: res?.error ?? res?.limit?.text ?? (res ? undefined : "the turn threw"), usd: spent.usd, tokens: spent.tokens, host: hostname() } as TurnRecord);
    }
  }
}

/** A review reserves one extra capacity unit; its reader must remain in the foreground. */
export function delegateBudget(max: number) {
  const running = new Set<string>();
  const before: HookCallback = async (input, id) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const args = input.tool_input as Record<string, unknown>;
    if (!id || args.run_in_background || running.size >= max) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Consort permits only the reserved foreground review reader. Finish it before starting another." } };
    running.add(id); return {};
  };
  const after: HookCallback = async (_, id) => { if (id) running.delete(id); return {}; };
  return {
    PreToolUse: [{ matcher: "^(Agent|Task)$", hooks: [before] }],
    PostToolUse: [{ matcher: "^(Agent|Task)$", hooks: [after] }],
    PostToolUseFailure: [{ matcher: "^(Agent|Task)$", hooks: [after] }],
  };
}

async function runClaude(o: TurnOptions): Promise<Turn> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const chunks: string[] = [];
  let sessionId = o.resume;
  let error: string | undefined;
  let limitText: string | undefined;
  let rejected: LimitHit | undefined;
  let usage: TurnUsage[] | undefined;
  const ac = new AbortController();
  let q: ReturnType<typeof query> | undefined;
  const stop = () => { ac.abort(); try { q?.close?.(); } catch {} };
  const abort = () => ac.abort();
  o.signal?.addEventListener("abort", abort, { once: true });
  if (o.signal?.aborted) ac.abort();
  inFlight.add(stop);
  let stderr = ""; // the CLI's own complaints: a usage limit or a crash arrives here, not in the message stream
  const flat = (content: unknown) => Array.isArray(content) ? content.map((b: any) => (b?.type === "text" ? b.text : "")).join("") : typeof content === "string" ? content : "";
  try {
  q = query({
    prompt: o.prompt,
    options: {
      cwd: o.cwd, model: o.model, resume: o.resume, pathToClaudeCodeExecutable: binaryFor("claude"), abortController: ac,
      stderr: (d: string) => { stderr = (stderr + d).slice(-4000); },
      env: envFor(o.account, { ...o.env, ...(o.delegateModel ? { CLAUDE_CODE_SUBAGENT_MODEL: o.delegateModel } : {}) }), settingSources: o.settingSources ?? ["user", "project", "local"],
      permissionMode: o.readOnly ? "plan" : "bypassPermissions", allowDangerouslySkipPermissions: !o.readOnly,
      ...((o.maxDelegates ?? 0) > 0 ? { hooks: delegateBudget(1) } : {}),
      disallowedTools: [...((o.maxDelegates ?? 0) > 0 ? [] : ["Agent", "Task"]), ...(o.offline ? ["WebSearch", "WebFetch"] : [])],
      ...(o.effort ? { effort: o.effort } : {}),
      ...(o.maxTurns ? { maxTurns: o.maxTurns } : {}),
    },
  });
  for await (const m of q as AsyncIterable<any>) {
    if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
    else if (m.type === "rate_limit_event") rejected = limitFromRateEvent(m.rate_limit_info) ?? rejected;
    else if (m.type === "assistant") {
      const said = flat(m.message?.content);
      if ((m.error === "rate_limit" || m.error === "billing_error") && isUsageLimitText(said)) limitText = said;
      else for (const b of m.message?.content ?? []) if (b.type === "text" && b.text) { chunks.push(b.text); o.onText?.(b.text); }
    } else if (m.type === "result") {
      // one query() is one turn here, so its per-model totals are this turn's spend
      const mu = m.modelUsage as Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }> | undefined;
      if (mu && Object.keys(mu).length) usage = Object.entries(mu).map(([model, u]) => ({ model, tokens: { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheRead: u.cacheReadInputTokens ?? 0, cacheWrite: u.cacheCreationInputTokens ?? 0 }, usd: typeof u.costUSD === "number" ? u.costUSD : undefined }));
      else if (m.usage) usage = [{ model: o.model, tokens: { input: m.usage.input_tokens ?? 0, output: m.usage.output_tokens ?? 0, cacheRead: m.usage.cache_read_input_tokens ?? 0, cacheWrite: m.usage.cache_creation_input_tokens ?? 0 }, usd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined }];
      // a usage limit ends the turn as a "success" flagged is_error, with the limit notice as its result
      const said = [m.result, ...(m.errors ?? [])].find(isUsageLimitText);
      if (said) limitText = said;
      else if (m.subtype !== "success") error = (m.errors ?? []).join("\n") || m.subtype;
    }
  }
  } catch (e) {
    // the process died: with a limit notice on stderr that is a limit (failover), otherwise a crash the caller may retry
    const said = stderr.trim();
    const looksLikeLimit: boolean = isUsageLimitText(said as unknown) || /usage limit|rate.?limit|\b429\b|overloaded/i.test(said);
    if (looksLikeLimit) limitText = said.split("\n").find((l) => /limit|429|overloaded/i.test(l)) ?? said.slice(0, 200);
    else error = `${(e as Error).message}${said ? `: ${said.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 300)}` : ""}`;
  } finally { inFlight.delete(stop); o.signal?.removeEventListener("abort", abort); }
  const limit = limitText || rejected ? { text: limitText ?? "usage limit", window: rejected?.window, resetsAt: rejected?.resetsAt } : undefined;
  return { text: chunks.join("\n"), sessionId, error, limit, usage };
}

async function runCodex(o: TurnOptions): Promise<Turn> {
  const { Codex } = await import("@openai/codex-sdk");
  const codex = new Codex({ ...(o.account.auth === "key" && o.account.apiKey ? { apiKey: o.account.apiKey } : {}), codexPathOverride: binaryFor("codex"), env: envFor(o.account, o.env) as Record<string, string>, config: { agents: { enabled: (o.maxDelegates ?? 0) > 0, max_concurrent_threads_per_session: 1, ...(o.delegateModel ? { default_subagent_model: o.delegateModel, default_subagent_reasoning_effort: "low" } : {}) } } });
  // unattended: no approvals, full access on this box, and the web for research
  const opts = { model: o.model, workingDirectory: o.cwd, skipGitRepoCheck: true, sandboxMode: o.readOnly ? "read-only" as const : "danger-full-access" as const, networkAccessEnabled: !o.offline, approvalPolicy: "never" as const, webSearchEnabled: !o.offline, ...(o.offline ? {} : { webSearchMode: "live" as const }), ...(o.effort ? { modelReasoningEffort: codexEffort(o.effort) } : {}) };
  const thread = o.resume ? codex.resumeThread(o.resume, opts) : codex.startThread(opts);
  const texts: string[] = [];
  let sessionId = o.resume;
  let error: string | undefined;
  let limit: LimitHit | undefined;
  let usage: TurnUsage[] | undefined;
  const ac = new AbortController();
  const stop = () => ac.abort();
  o.signal?.addEventListener("abort", stop, { once: true });
  if (o.signal?.aborted) ac.abort();
  inFlight.add(stop);
  const fail = (message: string) => { if (isCodexLimitText(message)) limit = { text: message }; else error = message; };
  try {
    const { events } = await thread.runStreamed(o.prompt, { signal: ac.signal });
    for await (const ev of events as AsyncIterable<any>) {
      if (ev.type === "thread.started") sessionId = ev.thread_id;
      else if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) { texts.push(ev.item.text); o.onText?.(ev.item.text); }
      else if (ev.type === "item.completed" && ev.item?.type === "error" && ev.item.message) { fail(String(ev.item.message)); if (limit) break; }
      else if (ev.type === "turn.completed" && ev.usage) usage = [{ model: o.model, tokens: { input: ev.usage.input_tokens ?? 0, output: ev.usage.output_tokens ?? 0, cacheRead: ev.usage.cached_input_tokens ?? 0, cacheWrite: ev.usage.cache_write_input_tokens ?? 0 } }];
      else if (ev.type === "turn.failed") { fail(ev.error?.message ?? "turn failed"); break; }
      else if (ev.type === "error") { fail(ev.message ?? "error"); break; }
    }
  } catch (e) { fail(String((e as Error).message ?? e)); }
  inFlight.delete(stop);
  o.signal?.removeEventListener("abort", stop);
  return { text: texts.join("\n"), sessionId, error, limit, usage };
}

/** a one-line "is this account usable" check: version of the binary and whether the login dir has credentials */
export async function accountStatus(account: Account): Promise<string> {
  try {
    const bin = binaryFor(account.provider);
    const version = (await run(bin, ["--version"], { timeout: 15_000 })).stdout.trim().split("\n")[0];
    if (account.auth === "key") return `${version} · API key`;
    if (account.provider === "claude") {
      const out = await run(bin, ["auth", "status"], { timeout: 15_000, env: envFor(account) as NodeJS.ProcessEnv }).then((r) => r.stdout, (e) => e.stdout ?? "{}");
      const j = JSON.parse(out || "{}");
      return `${version} · ${j.loggedIn ? `signed in${j.email ? ` as ${j.email}` : ""}` : "not signed in"}`;
    }
    const { stdout, stderr } = await run(bin, ["login", "status"], { timeout: 15_000, env: envFor(account) as NodeJS.ProcessEnv }).catch((e) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));
    const out = `${stdout}${stderr}`.trim().split("\n")[0];
    return `${version} · ${out || "not signed in"}`;
  } catch (e) { return `unavailable: ${(e as Error).message.split("\n")[0]}`; }
}

/** the interactive login for a CLI account, run in the user's terminal with the account's own config dir */
export async function loginInteractive(account: Account): Promise<void> {
  const { spawn } = await import("node:child_process");
  const bin = binaryFor(account.provider);
  const args = account.provider === "claude" ? ["auth", "login", "--claudeai"] : ["login"];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: "inherit", env: envFor(account) as NodeJS.ProcessEnv });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${bin} ${args.join(" ")} exited with ${code}`))));
    child.on("error", reject);
  });
}
