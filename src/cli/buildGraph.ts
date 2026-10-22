/**
 * The build's dependency graph, read from the ticket files under `.consort/ship/issues/` (each
 * with `Blocked by:`, `Files:` and `Status:`), worked out in code: which tickets can start now, and
 * the waves after them (each wave is every ticket whose blockers are all in earlier waves). A graph
 * that is mostly a chain gets one re-split by the agent before the build goes on.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ticketStatus } from "./buildProgress";

export type GraphTicket = { id: string; title: string; status: string; blockedBy: string[]; files: string[] };
export type BuildGraph = { waves: string[][]; remaining: number; done: number; problems: string[] };

const field = (text: string, name: string) => text.match(new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s+)?(?:\\*\\*)?${name}:(?:\\*\\*)?\\s*([^\\n]+)`, "i"))?.[1]?.replace(/\*/g, "").trim();
/** "02-record-service.md" and "02" name the same ticket in Blocked by lines */
const short = (id: string) => id.match(/^\d+/)?.[0] ?? id;

export async function readGraph(worktree: string): Promise<GraphTicket[]> {
  const dir = join(worktree, ".consort", "ship", "issues");
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".md")).sort();
  return Promise.all(files.map(async (file) => {
    const text = await readFile(join(dir, file), "utf8");
    const blocked = field(text, "Blocked by") ?? "";
    return {
      id: file.replace(/\.md$/, ""),
      title: text.match(/^#\s*(.+)$/m)?.[1]?.trim() ?? file,
      status: ticketStatus(text) ?? "unknown",
      blockedBy: /^(?:none|n\/a|—|-|)$/i.test(blocked) ? [] : blocked.split(/[,;\s]+/).map((s) => s.replace(/\.md$/, "").replace(/[`*]/g, "")).filter((s) => /\w/.test(s)),
      files: (field(text, "Files") ?? "").split(/[,;]/).map((s) => s.replace(/\s*\(.*$/, "").trim().replace(/^`|`$/g, "").trim()).filter(Boolean),
    };
  }));
}

const isDone = (t: GraphTicket) => /^(?:done|complete[d]?)\b/.test(t.status);
const within = (file: string, scope: string) => file === scope || file.startsWith(scope.replace(/\/$/, "") + "/");

/** waves of the unfinished tickets, in order; blockers that are done or unknown do not hold a ticket back */
export function planWaves(tickets: GraphTicket[]): BuildGraph {
  const byShort = new Map(tickets.map((t) => [short(t.id), t]));
  const find = (ref: string) => tickets.find((t) => t.id === ref) ?? byShort.get(short(ref));
  const open = tickets.filter((t) => !isDone(t));
  const problems: string[] = [];
  const deps = new Map(open.map((t) => [t.id, t.blockedBy.map((b) => {
    const hit = find(b);
    if (!hit) problems.push(`${t.id} is blocked by unknown ticket ${b}`);
    return hit && !isDone(hit) ? hit.id : undefined;
  }).filter((d): d is string => !!d)]));
  const waves: string[][] = [];
  const placed = new Set<string>();
  while (placed.size < open.length) {
    const wave = open.filter((t) => !placed.has(t.id) && deps.get(t.id)!.every((d) => placed.has(d))).map((t) => t.id);
    if (!wave.length) { problems.push(`Dependency cycle among ${open.filter((t) => !placed.has(t.id)).map((t) => t.id).join(", ")}`); break; }
    waves.push(wave);
    wave.forEach((id) => placed.add(id));
  }
  for (const wave of waves) {
    const inWave = wave.map((id) => open.find((t) => t.id === id)!);
    for (let i = 0; i < inWave.length; i++) for (let j = i + 1; j < inWave.length; j++) {
      const a = inWave[i], b = inWave[j];
      if (a.files.some((x) => b.files.some((y) => within(x, y) || within(y, x)))) problems.push(`${a.id} and ${b.id} share files but could run together`);
    }
  }
  return { waves, remaining: open.length, done: tickets.length - open.length, problems };
}

/** mostly a chain: at least six tickets left and fewer than two per wave on average */
export const tooSerial = (g: BuildGraph) => g.remaining >= 6 && g.waves.length > g.remaining / 2;

export const graphSummary = (g: BuildGraph) =>
  `${g.remaining} ticket${g.remaining === 1 ? "" : "s"} left in ${g.waves.length} wave${g.waves.length === 1 ? "" : "s"}, up to ${Math.max(0, ...g.waves.map((w) => w.length))} at once`;

/** the one re-split turn for a graph that is mostly a chain */
export const RESPLIT_PROMPT = (g: BuildGraph, tickets: GraphTicket[]) => `## This turn: re-split the remaining build tickets so they can run in parallel

Consort runs every ticket whose blockers are done at the same time, each in its own worktree. The remaining tickets form ${g.waves.length} waves for ${g.remaining} tickets, which is mostly a chain:
${g.waves.map((w, i) => `- wave ${i + 1}: ${w.join(", ")}`).join("\n")}
${g.problems.length ? `\nProblems found:\n${g.problems.map((p) => `- ${p}`).join("\n")}\n` : ""}
Rewrite only the tickets that are not done (${tickets.filter((t) => !isDone(t)).map((t) => t.id).join(", ")}) in .consort/ship/issues/. Do not change done tickets or code in this turn.
- Split by objective and by the code each objective lives in, not by the order the ticket or its subtasks were written. One ticket owns one area of files.
- Put shared contracts (types, interfaces, schema, a stub client) in one small ticket first, so the tickets that use them can run side by side against the contract.
- "Blocked by" only when a ticket truly needs another one's code to compile or test. Prefer more, smaller tickets that start now over a long chain.
- Every ticket keeps explicit, non-overlapping Files, a Blocked by line (none or ticket IDs), Status: ready-for-agent, and acceptance criteria. Number new files after the highest existing number; delete files you merge away.
- Keep the final sweep/PR ticket last.
When done, print the new waves (which tickets start together) and emit [ship-next: /ship].`;
