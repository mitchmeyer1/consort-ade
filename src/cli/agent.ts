import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { cliBinary, type Deps as RuntimeDeps } from "../main/cliRuntime";
import type { Provider } from "../shared/types";
import { HOME, type Account } from "./state";
import { isCodexLimitText, isUsageLimitText, limitFromRateEvent, type LimitHit } from "../shared/seatPool.ts";

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

export type TurnOptions = { cwd: string; prompt: string; model: string; account: Account; resume?: string; maxTurns?: number; onText?: (t: string) => void; /** the task's own ports and Docker names, on top of the process env */ env?: Record<string, string> };
export type Turn = { text: string; sessionId?: string; error?: string; limit?: LimitHit };

const envFor = (account: Account, extra: Record<string, string> = {}): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY;
  if (account.auth === "key" && account.apiKey) env[account.provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"] = account.apiKey;
  if (account.auth === "login" && account.configDir) env[account.provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] = account.configDir;
  return env;
};

export async function runTurn(o: TurnOptions): Promise<Turn> {
  return o.account.provider === "claude" ? runClaude(o) : runCodex(o);
}

async function runClaude(o: TurnOptions): Promise<Turn> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const chunks: string[] = [];
  let sessionId = o.resume;
  let error: string | undefined;
  let limitText: string | undefined;
  let rejected: LimitHit | undefined;
  const q = query({
    prompt: o.prompt,
    options: {
      cwd: o.cwd, model: o.model, resume: o.resume, pathToClaudeCodeExecutable: binaryFor("claude"),
      env: envFor(o.account, o.env), settingSources: ["user", "project", "local"],
      permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
      ...(o.maxTurns ? { maxTurns: o.maxTurns } : {}),
    },
  });
  const flat = (content: unknown) => Array.isArray(content) ? content.map((b: any) => (b?.type === "text" ? b.text : "")).join("") : typeof content === "string" ? content : "";
  for await (const m of q as AsyncIterable<any>) {
    if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
    else if (m.type === "rate_limit_event") rejected = limitFromRateEvent(m.rate_limit_info) ?? rejected;
    else if (m.type === "assistant") {
      const said = flat(m.message?.content);
      if ((m.error === "rate_limit" || m.error === "billing_error") && isUsageLimitText(said)) limitText = said;
      else for (const b of m.message?.content ?? []) if (b.type === "text" && b.text) { chunks.push(b.text); o.onText?.(b.text); }
    } else if (m.type === "result") {
      // a usage limit ends the turn as a "success" flagged is_error, with the limit notice as its result
      const said = [m.result, ...(m.errors ?? [])].find(isUsageLimitText);
      if (said) limitText = said;
      else if (m.subtype !== "success") error = (m.errors ?? []).join("\n") || m.subtype;
    }
  }
  const limit = limitText || rejected ? { text: limitText ?? "usage limit", window: rejected?.window, resetsAt: rejected?.resetsAt } : undefined;
  return { text: chunks.join("\n"), sessionId, error, limit };
}

async function runCodex(o: TurnOptions): Promise<Turn> {
  const { Codex } = await import("@openai/codex-sdk");
  const codex = new Codex({ ...(o.account.auth === "key" && o.account.apiKey ? { apiKey: o.account.apiKey } : {}), codexPathOverride: binaryFor("codex"), env: envFor(o.account, o.env) as Record<string, string> });
  // unattended: no approvals, full access on this box, and the web for research
  const opts = { model: o.model, workingDirectory: o.cwd, skipGitRepoCheck: true, sandboxMode: "danger-full-access" as const, networkAccessEnabled: true, approvalPolicy: "never" as const, webSearchEnabled: true, webSearchMode: "live" as const };
  const thread = o.resume ? codex.resumeThread(o.resume, opts) : codex.startThread(opts);
  const texts: string[] = [];
  let sessionId = o.resume;
  let error: string | undefined;
  let limit: LimitHit | undefined;
  const fail = (message: string) => { if (isCodexLimitText(message)) limit = { text: message }; else error = message; };
  try {
    const { events } = await thread.runStreamed(o.prompt);
    for await (const ev of events as AsyncIterable<any>) {
      if (ev.type === "thread.started") sessionId = ev.thread_id;
      else if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) { texts.push(ev.item.text); o.onText?.(ev.item.text); }
      else if (ev.type === "item.completed" && ev.item?.type === "error" && ev.item.message) fail(String(ev.item.message));
      else if (ev.type === "turn.failed") fail(ev.error?.message ?? "turn failed");
      else if (ev.type === "error") fail(ev.message ?? "error");
    }
  } catch (e) { fail(String((e as Error).message ?? e)); }
  return { text: texts.join("\n"), sessionId, error, limit };
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
