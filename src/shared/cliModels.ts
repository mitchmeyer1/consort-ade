import type { Provider } from "./types.ts";

/** CLI roles stay stable when an account or provider changes. Desktop tiers are separate. */
export type CliModelRole = "planning" | "implementation" | "coordination" | "reader" | "frontier";
export type CliModelPolicy = Partial<Record<CliModelRole, Partial<Record<Provider, string>>>>;

/** Family outranks release number: Astra 6 remains above Sol 6.1. */
export function cliModelRank(id: string): number {
  const m = id.toLowerCase().replace(/-\d{8,}$/, "");
  const family = /fable|mythos|astra/.test(m) ? 5 : /opus/.test(m) ? 4 : /sonnet|sol|terra/.test(m) ? 3 : /haiku|luna|mini|nano/.test(m) ? 1 : 2;
  const version = /(\d+)(?:[.-](\d+))?/.exec(m);
  return family * 1_000_000 + (version ? +version[1] * 1000 + +(version[2] ?? 0) : 0);
}

export const cliModelsByCapability = (models: string[]): string[] =>
  [...models].sort((a, b) => cliModelRank(b) - cliModelRank(a));

/** Explicit settings may name a release newer than the static seed catalog. */
export function selectCliModel(provider: Provider, available: string[], role: CliModelRole, policy: CliModelPolicy = {}): string {
  const belongs = (id: string) => provider === "claude" ? /^claude-/.test(id) : /^gpt-/.test(id);
  const configured = policy[role]?.[provider];
  if (configured && !belongs(configured)) throw new Error(`Model ${configured} does not belong to ${provider}`);
  if (configured) return configured;
  const ranked = cliModelsByCapability(available.filter(belongs));
  if (role === "frontier") return ranked[0] ?? "";
  const routine = ranked.find((id) => /sonnet|(?:^|-)sol(?:-|$)/.test(id));
  if (role === "reader") return ranked.find((id) => /haiku|luna|mini|nano/.test(id)) ?? routine ?? ranked.at(-1) ?? "";
  // Do not fall back from ordinary work to an extraction model when a stronger model exists.
  return routine ?? ranked.find((id) => !/fable|mythos|astra|haiku|luna|mini|nano/.test(id)) ?? ranked[0] ?? "";
}
