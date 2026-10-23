import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { HookCallback, HookCallbackMatcher, HookEvent, PostToolUseHookInput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_WAREHOUSE_COMMANDS, warehouseProblem } from "../shared/warehouse.ts";
import { runsAny } from "../shared/shellCommands.ts";
import { KEY_DENY, keyExposure, protectedPath, searchExposure } from "../shared/keyGuard.ts";
import { ALIAS_DENY, EGRESS_FOUND, EGRESS_UNSCANNABLE, PUSH_DENY, egressOf } from "../shared/egress.ts";
import { piiSpans, redactSpans, scanPii, shapeLine } from "../shared/piiGate.ts";
import { redactPii } from "../shared/redact.ts";
import type { PhiSettings } from "../shared/phi.ts";
import { gateFile, gateText, incident, pushFindings, UNSCANNABLE, type GateContext, type Git } from "./phiGate.ts";
import { HOME } from "./state.ts";

/**
 * The PHI/PII guard's enforcement inside every uncovered Claude turn, as Agent SDK hooks that run
 * in this process before and after each tool call. Before Bash runs: no key exposure, a
 * warehouse command only when it hides no statement, writes nothing and brings no identifier's
 * value back, no git alias, and nothing leaves the machine that the PII gate withholds; a push is
 * scanned over what it sends that the remote does not have. Before a file tool reads: no shell
 * startup file, Consort secret or file named as member data, and no search over a folder that
 * holds one. After a
 * warehouse command or an MCP tool: identifiers in the output are masked before the model sees
 * it, and output the gate cannot read is withheld. Each callback denies, or withholds, when its
 * own check throws. The covered analyst has its own hooks (cli/covered.ts).
 */

export type HookSet = Partial<Record<HookEvent, HookCallbackMatcher[]>>;
export type PhiHookContext = GateContext & { /** origin/<the job's base>, excluded from a push's scan beside every remote-tracking branch */ base?: string };
export type PhiHookDeps = { git: Git; readFile: (path: string) => Buffer; home: string; consortHome: string };

const run = promisify(execFile);
const realDeps: PhiHookDeps = {
  git: async (args, cwd) => (await run("git", args, { cwd, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })).stdout,
  readFile: (path) => readFileSync(path),
  home: homedir(),
  consortHome: HOME,
};

export const OUTPUT_WITHHELD = "[output withheld by Consort's PII gate: it could not be scanned. Rewrite the query at count or predicate level.]";
const PUSH_UNKNOWN = "Not pushed: Consort cannot tell which commits this push sends. Push the task's branch by name, from the task's worktree.";
// git's own subcommands; an alias cannot shadow one, so only other words are looked up as aliases
const GIT_BUILTINS = new Set(["add", "am", "apply", "bisect", "blame", "branch", "cat-file", "checkout", "cherry-pick", "clean", "clone", "commit", "config", "describe", "diff", "fetch", "for-each-ref", "format-patch", "grep", "init", "log", "ls-files", "ls-remote", "ls-tree", "merge", "merge-base", "mv", "notes", "pull", "push", "rebase", "reflog", "remote", "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "shortlog", "show", "stash", "status", "submodule", "switch", "symbolic-ref", "tag", "update-ref", "worktree"]);

export function phiHooks(c: PhiHookContext, deps: PhiHookDeps = realDeps): HookSet {
  const commands = [...new Set([...DEFAULT_WAREHOUSE_COMMANDS, ...c.phi.warehouseCommands])];
  const where = (cwd: string) => ({ cwd, home: deps.home, consortHome: deps.consortHome });

  const bash: HookCallback = async (input) => {
    try {
      const { tool_input, cwd } = input as PreToolUseHookInput;
      const command = String((tool_input as { command?: unknown } | undefined)?.command ?? "");
      const exposure = keyExposure(command, where(cwd));
      if (exposure) return deny(KEY_DENY(exposure));
      const problem = runsAny(command, commands) ? warehouseProblem(command, { names: commands, columns: c.phi.identifierColumns, tables: c.phi.personTables }) : undefined;
      if (problem) return deny(problem);
      const out = egressOf(command);
      if (out.deny) return deny(out.deny);
      for (const git of out.git.filter((g) => !GIT_BUILTINS.has(g.subcommand))) {
        const defined = await deps.git(["config", "--get", `alias.${git.subcommand}`], resolve(cwd, git.dir ?? ".")).catch(() => "");
        if (defined.trim()) return deny(ALIAS_DENY);
      }
      for (const file of out.files) {
        const verdict = gateFile("text sent from an agent turn", resolve(cwd, file), c, deps.readFile);
        if (!verdict.ok) return deny(verdict === UNSCANNABLE ? EGRESS_UNSCANNABLE : EGRESS_FOUND(verdict.categories));
      }
      for (const text of out.texts) {
        const verdict = gateText("text sent from an agent turn", text, c);
        if (!verdict.ok) return deny(EGRESS_FOUND(verdict.categories));
      }
      if (!out.push) return {};
      const findings = await pushFindings(deps.git, resolve(cwd, out.push.dir ?? "."), [...out.push.sources, "--not", "--remotes", ...(c.base ? [c.base] : [])], c).catch(() => undefined);
      if (!findings) return deny(PUSH_UNKNOWN);
      return findings.length ? deny(PUSH_DENY(findings)) : {};
    } catch {
      return deny("Not run: the PHI/PII guard could not check this command.");
    }
  };

  const files: HookCallback = async (input) => {
    try {
      const { tool_name, tool_input, cwd } = input as PreToolUseHookInput;
      const fields = (tool_input ?? {}) as Record<string, unknown>;
      const search = tool_name === "Grep" || tool_name === "Glob";
      for (const name of ["file_path", "notebook_path", "path", ...(tool_name === "Glob" ? ["pattern"] : [])]) {
        const value = fields[name];
        const why = typeof value !== "string" || !value ? undefined : search && name === "path" ? searchExposure(value, where(cwd)) : protectedPath(value, where(cwd));
        if (why) return deny(`Not read: ${why}.`);
      }
      return {};
    } catch {
      return deny("Not read: the PHI/PII guard could not check this path.");
    }
  };

  const output: HookCallback = async (input) => {
    const { tool_name, tool_input, tool_response } = input as PostToolUseHookInput;
    try {
      if (tool_name === "Bash" && !runsAny(String((tool_input as { command?: unknown } | undefined)?.command ?? ""), commands)) return {};
      const masked = maskOutput(tool_response, c.phi);
      if (!masked) return replace(tool_name === "Bash" ? { stdout: OUTPUT_WITHHELD, stderr: "" } : OUTPUT_WITHHELD);
      if (masked.highPrecision) incident(tool_name === "Bash" ? "warehouse output" : "MCP tool output", masked, c, "Masked before the agent saw it.");
      return masked.changed ? replace(masked.value) : {};
    } catch {
      return replace(tool_name === "Bash" ? { stdout: OUTPUT_WITHHELD, stderr: "" } : OUTPUT_WITHHELD);
    }
  };

  return {
    PreToolUse: [{ matcher: "^Bash$", hooks: [bash], timeout: 120 }, { matcher: "^(Read|Grep|Glob|NotebookRead)$", hooks: [files] }],
    // the only PostToolUse hook that rewrites output: the SDK runs them in parallel and the last rewrite wins
    PostToolUse: [{ matcher: "^Bash$|^mcp__", hooks: [output] }],
  };
}

/** each event's matchers from every set, in order */
export function mergeHooks(...sets: (HookSet | undefined)[]): HookSet | undefined {
  const merged: HookSet = {};
  for (const set of sets) for (const [event, matchers] of Object.entries(set ?? {}) as [HookEvent, HookCallbackMatcher[]][]) merged[event] = [...(merged[event] ?? []), ...matchers];
  return Object.keys(merged).length ? merged : undefined;
}

const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } });
const replace = (updatedToolOutput: unknown) => ({ hookSpecificOutput: { hookEventName: "PostToolUse" as const, updatedToolOutput } });

type Masked = { value: unknown; changed: boolean; highPrecision: boolean; categories: string; shapes: string };

/**
 * A tool's output with identifiers masked, in the shape it came in: a string, Bash's
 * {stdout, stderr}, or MCP text blocks, bare or under `content`. Undefined for anything else,
 * an image included, since the gate cannot read it.
 */
function maskOutput(response: unknown, phi: PhiSettings): Masked | undefined {
  let changed = false, highPrecision = false;
  const categories = new Set<string>(), shapes: string[] = [];
  const mask = (text: string) => {
    const scan = scanPii(text, "release", phi);
    highPrecision ||= scan.highPrecision;
    for (const f of scan.findings) if (f.tier === "block") categories.add(f.category);
    if (!scan.clean) shapes.push(shapeLine(scan));
    // names have no shape the gate can check; redactPii masks the common ones
    const out = redactPii(redactSpans(text, piiSpans(text, "release", phi)));
    changed ||= out !== text;
    return out;
  };
  const blocks = (list: unknown[]) => list.every((b) => typeof b === "string" || ((b as { type?: unknown })?.type === "text" && typeof (b as { text?: unknown }).text === "string"))
    ? list.map((b) => (typeof b === "string" ? mask(b) : { ...(b as object), text: mask((b as { text: string }).text) }))
    : undefined;
  const result = (value: unknown) => (value === undefined ? undefined : { value, changed, highPrecision, categories: [...categories].join(", "), shapes: shapes.join(" ") });
  if (typeof response === "string") return result(mask(response));
  if (Array.isArray(response)) return result(blocks(response));
  if (!response || typeof response !== "object") return undefined;
  const r = response as Record<string, unknown>;
  if (Array.isArray(r.content)) { const content = blocks(r.content); return result(content && { ...r, content }); }
  if (("stdout" in r || "stderr" in r) && !r.isImage) return result({ ...r, ...(typeof r.stdout === "string" ? { stdout: mask(r.stdout) } : {}), ...(typeof r.stderr === "string" ? { stderr: mask(r.stderr) } : {}) });
  return undefined;
}
