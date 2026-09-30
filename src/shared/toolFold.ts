import type { Block } from "./types";

/**
 * Quiet tool rows: consecutive tool calls fold into one summary line that grows as calls come in,
 * across the assistant messages the provider splits a turn into. A failed call stays out of the
 * fold, so errors are never hidden; the running call is counted and the line says it is running.
 * The prose is untouched.
 */
export type ToolBlock = Extract<Block, { type: "tool" }>;
type MessageLike = { id: string; role: string; blocks: Block[]; kind?: string };

/** consecutive assistant messages (nothing of another role between) shown as one, so their tool runs fold together */
export function mergeAssistantRuns<M extends MessageLike>(messages: M[]): M[] {
  const out: M[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (m.role === "assistant" && prev?.role === "assistant") out[out.length - 1] = { ...prev, blocks: [...prev.blocks, ...m.blocks] };
    else out.push(m);
  }
  return out;
}
export type Segment = { type: "text"; text: string } | { type: "tool"; block: ToolBlock } | { type: "fold"; tools: ToolBlock[] };

/** a call that must stay visible on its own: it failed */
export const pinned = (b: ToolBlock, _live: boolean) => b.ok === false;

export function groupBlocks(blocks: Block[], live: boolean): Segment[] {
  const out: Segment[] = [];
  let run: ToolBlock[] = [];
  const flush = () => { if (run.length) out.push({ type: "fold", tools: run }); run = []; };
  for (const b of blocks) {
    if (b.type === "text") { flush(); out.push({ type: "text", text: b.text }); continue; }
    if (pinned(b, live)) { flush(); out.push({ type: "tool", block: b }); continue; }
    run.push(b);
  }
  flush();
  return out;
}

/** "7 tool calls · Bash ×5 Read ×2", names in order of first use; "· running" while the last one is still going */
export function foldLabel(tools: ToolBlock[], live = false): string {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const names = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(" ");
  const running = live && tools.some((t) => t.ok === undefined);
  return `${tools.length} tool call${tools.length === 1 ? "" : "s"} · ${names}${running ? " · running" : ""}`;
}

/** the per-chat choice wins; otherwise the global setting; otherwise quiet */
export const showToolCalls = (chat: { showToolCalls?: boolean }, global: boolean | undefined) => chat.showToolCalls ?? global ?? false;
