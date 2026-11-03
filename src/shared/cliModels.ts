import type { Provider } from "./types.ts";

/** CLI roles stay stable when an account or provider changes. Desktop tiers are separate. */
export type CliModelRole = "planning" | "implementation" | "coordination" | "reader" | "frontier" | "evidence";
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
  const evidenceFamily = (id: string) => provider === "claude" ? /(?:^|-)opus(?:-|$)/.test(id) : /(?:^|-)sol(?:-|$)/.test(id);
  if (configured) {
    if (role === "evidence" && !evidenceFamily(configured)) throw new Error("Evidence requires an Opus model on Claude or a Sol model on Codex");
    return configured;
  }
  const ranked = cliModelsByCapability(available.filter(belongs));
  const top = ranked[0] ?? "";
  if (role === "evidence") {
    const model = ranked.find(evidenceFamily);
    if (!model) throw new Error(`No ${provider === "claude" ? "Opus" : "Sol"} model available for evidence`);
    return model;
  }
  // Judgement runs on the strongest model: planning decides what gets built, frontier reviews it.
  if (role === "frontier" || role === "planning") return top;
  const extraction = (id: string) => /haiku|luna|mini|nano/.test(id);
  const routine = ranked.find((id) => /sonnet|(?:^|-)sol(?:-|$)/.test(id));
  if (role === "reader") return ranked.find(extraction) ?? routine ?? ranked.at(-1) ?? "";
  // The build is nearly all of the tokens, so it runs one tier below the planner that specified it.
  if (role === "implementation") return ranked.find((id) => cliModelRank(id) < cliModelRank(top) && !extraction(id)) ?? top;
  // Do not fall back from ordinary work to an extraction model when a stronger model exists.
  return routine ?? ranked.find((id) => !/fable|mythos|astra/.test(id) && !extraction(id)) ?? top;
}

/** Fable, Mythos and Astra: the frontier family a scanner set to stay off frontier models never uses */
export const isFrontierModel = (id: string): boolean => /fable|mythos|astra/.test(id.toLowerCase());

/** the catalog without the frontier family, for a scanner with noFrontier set; every role then picks from what is left */
export const withoutFrontier = <K extends string>(models: Record<K, string[]>): Record<K, string[]> =>
  Object.fromEntries(Object.entries<string[]>(models).map(([k, list]) => [k, list.filter((m) => !isFrontierModel(m))])) as Record<K, string[]>;
