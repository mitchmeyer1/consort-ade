/**
 * ClickUp subtasks follow the build. The worker saves the ticket's subtasks to
 * `.consort/ship/SUBTASKS.md`; each build ticket names the subtasks it delivers on a `ClickUp:`
 * line. After every step, code (not the agent) moves each subtask forward: in progress once any of
 * its tickets starts, in review once all of them are built, complete when the PR merges. Each move
 * gets a comment on the subtask, and the parent gets one roll-up comment per step.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphTicket } from "./buildGraph";
import type { Source, Subtask } from "./sources";

export type SubtaskState = "progress" | "review" | "done";
const RANK: Record<SubtaskState, number> = { progress: 1, review: 2, done: 3 };
const isDone = (t: GraphTicket) => /^(?:done|complete[d]?)\b/.test(t.status);
const started = (t: GraphTicket) => isDone(t) || /^in[- ]?progress\b/.test(t.status);

export function writeSubtaskFile(worktree: string, subtasks: Subtask[]): void {
  const dir = join(worktree, ".consort", "ship");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SUBTASKS.md"), [
    "# ClickUp subtasks",
    "",
    "Name the IDs a build ticket delivers on its `**ClickUp:**` line. Consort moves these subtasks as the tickets land.",
    "",
    ...subtasks.map((s) => `- ${s.id}: ${s.name} (${s.status ?? "unknown"})${s.description ? `\n  ${s.description.replace(/\s+/g, " ").slice(0, 400)}` : ""}`),
    "",
  ].join("\n"));
}

/** where each subtask should be now, from the build tickets linked to it; unlinked subtasks are left alone */
export function subtaskTargets(subtasks: Subtask[], tickets: GraphTicket[]): Map<string, { state?: SubtaskState; tickets: GraphTicket[] }> {
  return new Map(subtasks.map((s) => {
    const linked = tickets.filter((t) => t.clickup.includes(s.id));
    const state: SubtaskState | undefined = !linked.length ? undefined : linked.every(isDone) ? "review" : linked.some(started) ? "progress" : undefined;
    return [s.id, { state, tickets: linked }];
  }));
}

/** tickets with no ClickUp line while the task has subtasks: the agent still has to link them */
export const needsLinks = (subtasks: Subtask[], tickets: GraphTicket[]) =>
  subtasks.length > 0 && tickets.some((t) => !isDone(t)) && tickets.every((t) => !t.clickup.some((id) => subtasks.some((s) => s.id === id)));

const names = (tickets: GraphTicket[]) => tickets.map((t) => t.title.replace(/^\d+[:.]\s*/, "")).join("; ");

/**
 * Move subtasks forward (never back) and comment on each move; returns the new saved states.
 * `force` moves every subtask to that state (the PR merged).
 */
export async function syncSubtasks(o: { source: Source; parentId: string; subtasks: Subtask[]; tickets: GraphTicket[]; saved: Record<string, SubtaskState>; where?: string; force?: SubtaskState; log?: (line: string) => void }): Promise<Record<string, SubtaskState>> {
  return (await syncSubtaskProgress({ ...o, noted: undefined })).states;
}

/**
 * The same, plus a comment on each subtask whenever one of its tickets lands ("significant work").
 * `noted` lists tickets already reported; undefined on the first sync, which records the tickets
 * already done without commenting, so an existing build is not replayed onto ClickUp.
 */
export async function syncSubtaskProgress(o: { source: Source; parentId: string; subtasks: Subtask[]; tickets: GraphTicket[]; saved: Record<string, SubtaskState>; noted: string[] | undefined; where?: string; force?: SubtaskState; log?: (line: string) => void }): Promise<{ states: Record<string, SubtaskState>; noted: string[] }> {
  const next = { ...o.saved };
  const moved: string[] = [];
  const landedNow = o.noted === undefined ? [] : o.tickets.filter((t) => isDone(t) && !o.noted!.includes(t.id) && t.clickup.length);
  const movingToBuilt = new Set<string>();
  for (const [id, target] of subtaskTargets(o.subtasks, o.tickets)) {
    // a merge completes only the subtasks the build delivered; one no ticket names (a manual step) is left to people
    const want = o.force && target.tickets.length ? o.force : target.state;
    if (!want || (next[id] && RANK[next[id]] >= RANK[want])) continue;
    if (want !== "progress") movingToBuilt.add(id);
    const sub = o.subtasks.find((s) => s.id === id)!;
    try {
      await o.source.setStatus(id, want);
      const text = want === "progress" ? `Consort started this: ${names(target.tickets.filter(started)) || "work began"}.`
        : want === "review" ? `Consort built this: ${names(target.tickets)}.${o.where ? ` ${o.where}` : ""}`
        : `Merged.${o.where ? ` ${o.where}` : ""}`;
      await o.source.comment(id, text);
      next[id] = want;
      moved.push(`${sub.name} → ${want === "progress" ? "in progress" : want === "review" ? "built, in review" : "complete"}`);
    } catch (e) { o.log?.(`subtask ${sub.name} not moved: ${(e as Error).message}`); }
  }
  // a ticket landed: say so on each subtask it serves, unless that subtask's "built" comment already names it
  for (const ticket of landedNow) for (const id of ticket.clickup) {
    if (movingToBuilt.has(id) || !o.subtasks.some((x) => x.id === id)) continue;
    await o.source.comment(id, `Consort landed part of this: ${names([ticket])}.${o.where ? ` ${o.where}` : ""}`).catch((e) => o.log?.(`landed comment failed: ${(e as Error).message}`));
  }
  if (moved.length) {
    const built = o.subtasks.filter((s) => next[s.id] === "review" || next[s.id] === "done").length;
    await o.source.comment(o.parentId, `Consort progress: ${built} of ${o.subtasks.length} subtasks built.\n${moved.map((m) => `• ${m}`).join("\n")}`).catch((e) => o.log?.(`progress comment failed: ${(e as Error).message}`));
  }
  return { states: next, noted: [...new Set([...(o.noted ?? []), ...o.tickets.filter(isDone).map((t) => t.id)])] };
}

/** the one turn that links existing build tickets to the ClickUp subtasks */
export const LINK_PROMPT = `## This turn: link the build tickets to the ClickUp subtasks

Read .consort/ship/SUBTASKS.md and every ticket in .consort/ship/issues/. Add a line "**ClickUp:** <subtask IDs>" under the Status line of each ticket, naming the subtasks that ticket helps deliver (one or more IDs from SUBTASKS.md; "none" for tickets like the final sweep that deliver none). Every subtask should be named by at least one ticket. Change nothing else: no code, no statuses, no other fields. Then emit [ship-next: /ship].`;
