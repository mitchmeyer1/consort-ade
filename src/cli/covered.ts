import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { apiKeyHelperFor, coveredEnv, coveredOutputContract, coveredRolePrompt, type CoveredAsk, type CoveredKeyRef, type CoveredResult, type PhiSettings } from "../shared/phi.ts";
import { categoryLine, scanPii, shapeLine } from "../shared/piiGate.ts";
import { redactPii } from "../shared/redact.ts";
import { readOnlyStatement, sameTable, tablesReferenced } from "../shared/warehouse.ts";
import { selectCliModel } from "../shared/cliModels.ts";
import { seedModels, type TurnUsage } from "../shared/headless.ts";
import { binaryFor, resultUsage } from "./agent";
import { HOME } from "./state";

/**
 * The covered analyst: one confined Claude turn on the organisation's BAA-covered API key, the
 * only session allowed to read member-level data. Consort never holds the key: the child's own
 * Claude Code fetches it through an apiKeyHelper command, and the turn stops unless the session
 * reports that helper as its credential. It runs in a scratch folder outside every worktree with
 * only the granted warehouse commands, read-only statements over a closed table list, no web, no
 * files, no MCP servers and no saved transcript. Its final message passes the release-posture
 * PII gate before anything else sees it; on any finding nothing is released. Nothing here falls
 * back to a subscription login: no key, no turn.
 */

const run = promisify(execFile);

export type KeyCheckDeps = { exec: (cmd: string, args: string[], timeoutMs: number) => Promise<unknown>; stat: (p: string) => { mode: number; uid: number; size: number } | undefined; uid: number; platform: NodeJS.Platform };
const keyCheckDeps: KeyCheckDeps = {
  exec: (cmd, args, timeoutMs) => run(cmd, args, { timeout: timeoutMs }),
  stat: (p) => { try { const s = statSync(p); return { mode: s.mode, uid: s.uid, size: s.size }; } catch { return undefined; } },
  uid: process.getuid?.() ?? -1,
  platform: process.platform,
};

/** whether the reference points at a key that exists and only its owner can read; the value itself is never read here */
export async function checkCoveredKey(ref: CoveredKeyRef | undefined, deps: KeyCheckDeps = keyCheckDeps): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!ref) return { ok: false, reason: "no covered key is configured (consort-cli phi key ref …)" };
  if (ref.kind === "keychain") {
    if (deps.platform !== "darwin") return { ok: false, reason: "a Keychain reference needs macOS; on this machine use phi key ref --file" };
    // without -w the lookup returns the item's attributes, not its secret; a timeout is a refusal so a locked keychain cannot hang a worker
    const found = await deps.exec("security", ["find-generic-password", "-s", ref.service, ...(ref.account ? ["-a", ref.account] : [])], 10_000).then(() => true, () => false);
    return found ? { ok: true } : { ok: false, reason: `the Keychain has no item ${ref.service}${ref.account ? ` for account ${ref.account}` : ""}, or it is locked` };
  }
  const st = deps.stat(ref.path);
  if (!st) return { ok: false, reason: `${ref.path} does not exist` };
  if ((st.mode & 0o077) !== 0) return { ok: false, reason: `${ref.path} is readable by other users; chmod 600 it` };
  if (st.uid !== deps.uid) return { ok: false, reason: `${ref.path} belongs to another user` };
  if (!st.size) return { ok: false, reason: `${ref.path} is empty` };
  return { ok: true };
}

type Query = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<any>;
export type CoveredDeps = { query: Query; check: typeof checkCoveredKey; scratch: (taskId: string) => string; remove: (dir: string) => void; binary: () => string; env: NodeJS.ProcessEnv };
const coveredDeps: CoveredDeps = {
  query: async function* (args) { const { query } = await import("@anthropic-ai/claude-agent-sdk"); yield* query(args as never) as AsyncIterable<any>; },
  check: checkCoveredKey,
  scratch: (taskId) => {
    mkdirSync(HOME, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(HOME, `covered-${taskId}-`));
    for (const sub of ["config", "tmp"]) mkdirSync(join(dir, sub), { mode: 0o700 });
    return dir;
  },
  remove: (dir) => rmSync(dir, { recursive: true, force: true }),
  binary: () => binaryFor("claude"),
  env: process.env,
};

const TOOLS_OFF = ["WebSearch", "WebFetch", "Agent", "Task", "Write", "Edit", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep", "Skill", "TodoWrite"];

export async function runCoveredTurn(req: { taskId: string; ask: CoveredAsk; phi: PhiSettings; ref?: CoveredKeyRef; signal?: AbortSignal; timeoutMs?: number; prompt?: string }, deps: CoveredDeps = coveredDeps): Promise<CoveredResult & { usage?: TurnUsage[] }> {
  const key = await deps.check(req.ref);
  if (!key.ok || !req.ref) return { status: "unavailable", reason: key.ok ? "no covered key is configured" : key.reason };
  const model = req.phi.coveredModel ?? selectCliModel("claude", seedModels().claude, "implementation");
  const scratch = deps.scratch(req.taskId);
  const abort = new AbortController();
  const stop = () => abort.abort();
  req.signal?.addEventListener("abort", stop);
  const timer = setTimeout(stop, req.timeoutMs ?? 15 * 60_000);
  let text = "", error: string | undefined, usage: TurnUsage[] | undefined;
  try {
    const q = deps.query({
      prompt: req.prompt ?? `${coveredRolePrompt(req.ask, req.phi.coveredGrant)}\n\n${coveredOutputContract(req.phi.minCell ?? 11)}`,
      options: {
        cwd: scratch, model, pathToClaudeCodeExecutable: deps.binary(), abortController: abort, env: coveredEnv(deps.env, scratch),
        settings: { apiKeyHelper: apiKeyHelperFor(req.ref) }, settingSources: [],
        permissionMode: "dontAsk", tools: ["Bash"], allowedTools: req.phi.coveredGrant.map((c) => `Bash(${c} *)`), disallowedTools: TOOLS_OFF,
        strictMcpConfig: true, mcpServers: {}, persistSession: false, maxTurns: req.phi.coveredMaxTurns ?? 12, effort: "high",
        hooks: coveredHooks(req.phi.coveredGrant, req.ask.tables),
      },
    });
    for await (const m of q) {
      // the turn is covered only if the session authenticated with the helper; anything else stops it before a query runs
      if (m.type === "system" && m.subtype === "init" && m.apiKeySource !== "apiKeyHelper") { error = "the session did not authenticate with the covered key"; abort.abort(); break; }
      if (m.type !== "result") continue;
      usage = resultUsage(m, model);
      if (m.subtype === "success" && typeof m.result === "string") text = m.result;
      else error = (m.errors ?? []).join("\n") || m.subtype;
    }
  } catch (e) {
    error ??= abort.signal.aborted ? "the covered turn ran out of time" : (e as Error).message;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", stop);
    deps.remove(scratch);
  }
  if (error || !text.trim()) {
    // an error message can quote what the analyst saw, so it crosses only if it is clean
    const said = (error ?? "the covered analyst returned nothing").split("\n")[0].slice(0, 200);
    return { status: "unavailable", reason: scanPii(said, "release", req.phi).clean ? `the covered analyst failed: ${said}` : "the covered analyst failed; its error text was withheld by the PII gate", usage };
  }
  const scan = scanPii(text, "release", req.phi);
  if (!scan.clean) return { status: "withheld", categories: categoryLine(scan), shapes: shapeLine(scan), usage };
  // names and labelled values have no shape the gate can check; mask what slips through
  return { status: "released", text: redactPii(text.trim()), warnings: scan.findings.filter((f) => f.tier === "warn").map((f) => f.category), usage };
}

/**
 * The covered session's only door: every tool call must be one granted warehouse command
 * carrying a read-only statement over the tables the question named. No chains, redirects or
 * tee (rows never reach a file), no background runs, nothing else. A check that throws denies.
 */
export function coveredHooks(grant: string[], tables: string[]) {
  const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } });
  const check: HookCallback = async (input) => {
    try {
      const call = input as { tool_name?: string; tool_input?: { command?: unknown; run_in_background?: unknown } };
      if (call.tool_name !== "Bash") return deny("Not run: the covered session runs warehouse commands only.");
      if (call.tool_input?.run_in_background) return deny("Not run: no background commands in the covered session.");
      const found = readOnlyStatement(String(call.tool_input?.command ?? ""), grant);
      if ("problem" in found) return deny(`Not run: ${found.problem}.`);
      const outside = tablesReferenced(found.statement).filter((t) => !tables.some((allowed) => sameTable(t, allowed)));
      if (outside.length) return deny(`Not run: ${outside.join(", ")} is outside the tables this question named (${tables.join(", ")}).`);
      return {};
    } catch {
      return deny("Not run: the guard could not check this command.");
    }
  };
  return { PreToolUse: [{ hooks: [check] }] };
}
