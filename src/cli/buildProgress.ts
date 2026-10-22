/**
 * Build progress: the spec step splits the build into tickets under `.consort/ship/issues/`, each
 * with a `Status:` line the agent moves to `done` as it lands them. Counting those gives
 * "Build 7/18" in `consort-cli view` and the Slack status line. Cached a few seconds per worktree.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type BuildProgress = { done: number; total: number };

/** `**Status:** done` → "done" */
export const ticketStatus = (text: string) => text.match(/(?:^|\n)\s*(?:[-*]\s+)?(?:\*\*)?Status:(?:\*\*)?\s*([^\n]+)/i)?.[1]?.replace(/[*`]/g, "").trim().toLowerCase();

export function countBuildTickets(statuses: (string | undefined)[]): BuildProgress | undefined {
  const known = statuses.filter((s): s is string => !!s);
  return known.length ? { done: known.filter((s) => /^(?:done|complete[d]?)\b/.test(s)).length, total: known.length } : undefined;
}

const cache = new Map<string, { at: number; value?: BuildProgress }>();
export function buildProgress(worktree: string | undefined, now = Date.now()): BuildProgress | undefined {
  if (!worktree) return undefined;
  const hit = cache.get(worktree);
  if (hit && now - hit.at < 5_000) return hit.value;
  let value: BuildProgress | undefined;
  try {
    const dir = join(worktree, ".consort", "ship", "issues");
    value = countBuildTickets(readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => { try { return ticketStatus(readFileSync(join(dir, f), "utf8")); } catch { return undefined; } }));
  } catch { value = undefined; }
  cache.set(worktree, { at: now, value });
  return value;
}

/** "Build" → "Build 7/18" while the build step runs and its tickets exist */
export const stepLabel = (name: string, worktree: string | undefined, now = Date.now()) => {
  if (name !== "Build") return name;
  const p = buildProgress(worktree, now);
  return p ? `${name} ${p.done}/${p.total}` : name;
};
