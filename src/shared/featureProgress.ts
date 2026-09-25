/**
 * The zoomed-out checklist. A `[plan: …]` covers one turn; a feature spans many: a plan file with
 * twenty items of which this turn does the first, a migration checked off table by table. The agent
 * decides whether a chat has one, declares it once with `[feature: title | item | item …]`, ticks
 * items with `[feature-done: 3, 4]` as they land, and the card sits on the right until every item
 * is done. Unlike the plan it survives across turns, and it is restated to the agent on each turn so
 * a fresh session or a compacted context still knows what is left.
 */
import type { Chat, ChatFeature, Stage } from "./types";

export const FEATURE_MARKER = /\[feature:([^\]]{0,1500})\]\s*/gi;
export const FEATURE_DONE_MARKER = /\[feature-done:([\d,\s]{1,80})\]\s*/gi;
export const FEATURE_NOW_MARKER = /\[feature-now:(\d{1,2})\]\s*/gi;
export const FEATURE_CLEAR_MARKER = /\[feature-clear\]\s*/gi;

const MAX_ITEMS = 24;
const MAX_LABEL = 64;
const MAX_TITLE = 48;

const tidy = (s: string, max: number) => s.trim().replace(/\s+/g, " ").replace(/^[-–—*\d.)\s]+/, "").replace(/^\[[ x]\]\s*/i, "").slice(0, max).trim();
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** "[feature: Roster sync | Schema | Cron | Admin page]" → title and items; fewer than two items is not a feature */
export function parseFeature(raw: string): { title: string; items: string[] } | null {
  const parts = raw.split(/[|;]/);
  const title = tidy(parts[0] ?? "", MAX_TITLE);
  const items = parts.slice(1).map((p) => tidy(p, MAX_LABEL)).filter(Boolean);
  return title && items.length >= 2 ? { title, items: items.slice(0, MAX_ITEMS) } : null;
}

/** a new declaration replaces the old one, keeping the ticks of items that carry over by name */
export function startFeature(parsed: { title: string; items: string[] }, previous: ChatFeature | undefined, now: number): ChatFeature {
  const done = new Map((previous?.items ?? []).filter((i) => i.doneAt !== undefined).map((i) => [key(i.label), i.doneAt!]));
  return { title: parsed.title, items: parsed.items.map((label) => { const at = done.get(key(label)); return at === undefined ? { label } : { label, doneAt: at }; }), ts: now };
}

/** "[feature-done: 1, 3]" (1-based): those items are finished; unknown numbers are ignored */
export function completeFeatureItems(feature: ChatFeature, raw: string, now: number): ChatFeature {
  const nums = new Set(raw.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= feature.items.length).map((n) => n - 1));
  if (!nums.size) return feature;
  const current = feature.current !== undefined && nums.has(feature.current) ? undefined : feature.current;
  return { ...feature, current, items: feature.items.map((i, idx) => nums.has(idx) && i.doneAt === undefined ? { ...i, doneAt: now } : i) };
}

/** "[feature-now:N]": the item this turn is working toward, when it is not simply the next undone one */
export function focusFeatureItem(feature: ChatFeature, step: number): ChatFeature {
  const idx = step - 1;
  return idx >= 0 && idx < feature.items.length && feature.items[idx]!.doneAt === undefined ? { ...feature, current: idx } : feature;
}

export const featureComplete = (feature: ChatFeature) => feature.items.every((i) => i.doneAt !== undefined);
export const featureCount = (feature: ChatFeature) => ({ done: feature.items.filter((i) => i.doneAt !== undefined).length, total: feature.items.length });

/** rows for the right-hand card: ticks for what is done, one live row for what is being worked toward */
export function featureStages(chat: Pick<Chat, "feature" | "running">): Stage[] | null {
  const feature = chat.feature;
  if (!feature?.items.length) return null;
  const live = chat.running ? (feature.current ?? feature.items.findIndex((i) => i.doneAt === undefined)) : -1;
  return feature.items.map((item, i) => ({ id: `feature-${i}`, label: item.label, state: item.doneAt !== undefined ? "done" : i === live ? "active" : "pending" }));
}

/** what the agent is reminded of at the start of every turn while a feature is open */
export function featureSummary(feature: ChatFeature): string {
  const { done, total } = featureCount(feature);
  const rows = feature.items.map((i, idx) => `${idx + 1}. [${i.doneAt !== undefined ? "x" : " "}] ${i.label}`).join("\n");
  return `Open feature checklist for this chat: ${feature.title} (${done}/${total} done)\n${rows}\nKeep it current: emit [feature-done: N] (numbers, comma-separated) as items are finished by the work in this turn, [feature-now:N] if you are working toward an item other than the first unfinished one, a fresh [feature: …] only if the scope itself changed, and [feature-clear] if it no longer applies.`;
}

export const FEATURE_PROMPT = `Separately from the per-task plan, decide whether this chat is one part of a larger piece of work with several parts that will be checked in between: a plan or spec file with many items of which this request does one or a few, a list the user is working down, a migration done table by table. If so, and only then, declare that larger checklist once, on its own line: [feature: short title | item | item | …] with 2 to 24 items in the file's or the user's order, each at most a few words, marking anything already finished with [feature-done: …] right after. Do not declare one for a self-contained task, a question, or a fix that ends this turn. While a feature is open, tick items as their work truly lands with [feature-done: N, M] (1-based), and say [feature-now:N] when you start on an item that is not the first unfinished one. The checklist stays on screen across turns until every item is ticked.`;
