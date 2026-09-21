/**
 * Which connector and model do the review's side jobs (re-investigate, draft the review body,
 * fix locally) run on? The review chat's own, when the branch has one for this PR: that is the
 * connector the user picked in the composer and the model they are already paying for. The
 * Settings default is only the fallback for a branch with no review chat at all.
 */
// value imports carry the extension: tests load this module straight into Node, which resolves relative imports literally
import type { ApiKey, Chat, Provider } from "./types";
import { isReviewChat } from "./reviewProgress.ts";
import { prNumberOf } from "./review.ts";
import { defaultConnector } from "./defaultConnector.ts";
import { modelTiers } from "./modelTiers.ts";

type Chats = Pick<Chat, "worktreeId" | "name" | "messages" | "lastChattedAt" | "keyId" | "model" | "delegateModel">;
type Snapshot<C extends Chats> = { keys: ApiKey[]; defaultKeyId?: string; chats: C[]; models?: Partial<Record<Provider, string[]>> };

/** the review chat for this PR on this branch, else the branch's most recent review chat */
export function pickReviewChat<C extends Chats>(chats: C[], worktreeId: string, pr: number | undefined): C | undefined {
  const own = chats.filter((c) => c.worktreeId === worktreeId && isReviewChat(c)).sort((a, b) => (b.lastChattedAt ?? 0) - (a.lastChattedAt ?? 0));
  return (pr === undefined ? undefined : own.find((c) => prNumberOf(c.name) === pr)) ?? own[0];
}

export type ReviewRunner = { key: ApiKey; model: string; from: "chat" | "default" };

/** connector and model for a review side job; undefined when the app has no connector at all */
export function reviewRunner<C extends Chats>(state: Snapshot<C>, worktreeId: string, pr: number | undefined): ReviewRunner | undefined {
  const chat = pickReviewChat(state.chats, worktreeId, pr);
  const key = chat && state.keys.find((k) => k.id === chat.keyId);
  // the chat's delegate tier is what its review agents ran on; a chat without one runs everything on its own model
  if (chat && key) return { key, model: chat.delegateModel || chat.model, from: "chat" };
  const fallback = defaultConnector(state);
  return fallback ? { key: fallback, model: modelTiers(fallback.provider, state.models?.[fallback.provider]).delegate, from: "default" } : undefined;
}
