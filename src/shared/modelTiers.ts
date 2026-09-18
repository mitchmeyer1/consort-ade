import type { Provider } from "./types";

/**
 * Delegated reviews run on two tiers. The orchestrator maps scope, writes the agent
 * prompts, decides each candidate and writes the report — high judgement, few tokens.
 * The agents it dispatches read files, grep and trace callers, which is nearly all of
 * the tokens, so they run one tier down. Spend then tracks the delegate tier while
 * quality tracks the orchestrator's prompts, instead of paying top-tier rates to read
 * a diff.
 */
export type ModelTiers = { orchestrator: string; delegate: string };

// Pinned, not derived: the providers' own lists are ordered by rollout priority, not by
// capability (Codex advertises sol before astra), so picking [0] and [1] tiers backwards.
const TIERS: Record<Provider, ModelTiers> = {
  claude: { orchestrator: "claude-fable-5-1", delegate: "claude-opus-5" },
  codex: { orchestrator: "gpt-6-astra", delegate: "gpt-5.6-sol" },
};

/**
 * Resolve the tiers against what the provider actually offers. A pinned model the
 * catalog has dropped falls back to the offered list's first entry for the orchestrator,
 * and to the orchestrator for the delegate — a review that costs too much still beats a
 * review dispatched to a model that no longer exists.
 */
export function modelTiers(provider: Provider, offered?: string[]): ModelTiers {
  const pinned = TIERS[provider];
  const list = offered?.length ? offered : [pinned.orchestrator, pinned.delegate];
  const orchestrator = list.includes(pinned.orchestrator) ? pinned.orchestrator : (list[0] ?? pinned.orchestrator);
  const delegate = list.includes(pinned.delegate) ? pinned.delegate : orchestrator;
  return { orchestrator, delegate };
}
