import { byCapability } from "./modelTiers.ts";

/**
 * The Claude CLI reports the models the signed-in account can use, as alias rows ("sonnet",
 * "opus[1m]", "default") that each resolve to a wire id. The picker wants the wire ids, once
 * each, in the order the CLI ranks them: the recommended default first.
 */
export type ClaudeModelRow = { value: string; resolvedModel?: string };

export function normalizeClaudeModels(rows: ClaudeModelRow[]): string[] {
  const ids = rows
    .map((r) => (r.resolvedModel ?? r.value).replace(/\[[^\]]*\]\s*$/, "").trim()) // "claude-opus-5[1m]" → "claude-opus-5"
    .filter((id) => /^claude-/i.test(id));
  return [...new Set(ids)];
}

/**
 * The Models API lists every release the account can call, newest first; the CLI names only
 * the handful it has aliases for. One list, each id once, strongest first (Fable over Opus
 * over Sonnet over Haiku, then version) so the picker reads the same on every connector and a
 * release newer than this build sorts itself in.
 */
export const mergeClaudeModels = (...lists: string[][]): string[] => byCapability([...new Set(lists.flat())]);
