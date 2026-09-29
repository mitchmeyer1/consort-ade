import type { ChatContext } from "./types";

/**
 * The context meter: how much of the model's window the last turn's final API call filled. The numerator
 * is that call's prompt (input + cache read + cache creation); the window comes from the SDK's result.
 */
export type ContextTone = "green" | "yellow" | "red";
export const contextTone = (percent: number): ContextTone => (percent >= 70 ? "red" : percent >= 30 ? "yellow" : "green");
export const contextPercent = (c: Pick<ChatContext, "used" | "window">) => (c.window > 0 ? Math.min(100, Math.max(0, Math.round((c.used / c.window) * 100))) : 0);

/** the prompt size of one API call, as the SDK reports usage on an assistant message */
export function promptTokens(usage: unknown): number | undefined {
  const u = usage as Record<string, unknown> | null;
  if (!u || typeof u !== "object") return;
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const total = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

/** the window of the model that did the turn's work: the chat's model when it is listed, else the busiest entry */
export function contextWindowOf(modelUsage: unknown, model: string): number | undefined {
  const m = modelUsage as Record<string, { contextWindow?: number; inputTokens?: number; cacheReadInputTokens?: number }> | null;
  if (!m || typeof m !== "object") return;
  const entries = Object.entries(m).filter(([, v]) => v && typeof v.contextWindow === "number" && v.contextWindow > 0);
  if (!entries.length) return;
  const own = entries.find(([k]) => k === model || k.includes(model) || model.includes(k));
  const load = ([, v]: (typeof entries)[number]) => (v.inputTokens ?? 0) + (v.cacheReadInputTokens ?? 0);
  return (own ?? entries.reduce((a, b) => (load(b) > load(a) ? b : a)))[1].contextWindow;
}
