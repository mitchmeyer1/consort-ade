/**
 * Delegated reviews run on two tiers. The orchestrator maps scope, writes the agent
 * prompts, decides each candidate and writes the report — high judgement, few tokens.
 * The agents it dispatches read files, grep and trace callers, which is nearly all of
 * the tokens, so they run one tier down. Spend then tracks the delegate tier while
 * quality tracks the orchestrator's prompts, instead of paying top-tier rates to read
 * a diff.
 *
 * Nothing here names a model version. Tiers are read off whatever the provider offers
 * today: family first (Fable and Mythos over Opus over Sonnet over Haiku), then version,
 * so a new release slots in the day it appears in the catalog.
 */
// the extension matters: tests load this module straight into Node
import { MODELS, type Provider } from "./types.ts";

export type ModelTiers = { orchestrator: string; delegate: string };

const FAMILY: [RegExp, number][] = [[/mythos|fable/, 4], [/opus/, 3], [/sonnet/, 2], [/haiku/, 1]];

/**
 * How capable a model id claims to be: its family, then its version ("claude-fable-5-1" → 5.1,
 * "gpt-5.6-sol" → 5.6, "gpt-6-astra" → 6). Date stamps ("…-20251001") are not versions.
 * Codex ids carry no family, so version alone orders them.
 */
export function rankModel(id: string): number {
  const lower = id.toLowerCase().replace(/\d{8,}/g, "");
  const family = FAMILY.find(([re]) => re.test(lower))?.[1] ?? 0;
  const m = /(\d+)(?:[.-](\d+))?/.exec(lower);
  const version = m ? +m[1] * 100 + (m[2] ? +m[2] : 0) : 0;
  return family * 10_000 + version;
}

/** the list ordered most capable first; ties keep the provider's own order */
export const byCapability = (models: string[]) =>
  models.map((id, i) => ({ id, i, r: rankModel(id) })).sort((a, b) => b.r - a.r || a.i - b.i).map((m) => m.id);

/**
 * Resolve the tiers against what the provider actually offers. The orchestrator is the most
 * capable model listed; the delegate is the best model strictly below it, or the orchestrator
 * itself when nothing lesser is offered — a review that costs too much still beats a review
 * dispatched to a model that does not exist.
 */
export function modelTiers(provider: Provider, offered?: string[]): ModelTiers {
  const list = offered?.length ? offered : MODELS[provider];
  const ranked = byCapability(list);
  const orchestrator = ranked[0] ?? "";
  const top = rankModel(orchestrator);
  const delegate = ranked.find((id) => rankModel(id) < top) ?? orchestrator;
  return { orchestrator, delegate };
}

/** the least capable model offered: for one-shot chores like naming a branch or drafting a commit message */
export const cheapestModel = (offered: string[] | undefined, fallback: string): string => {
  const ranked = byCapability(offered ?? []);
  return ranked[ranked.length - 1] ?? fallback;
};
