import type { Block } from "./types";

/**
 * Quiet tool rows: consecutive tool calls in a response fold into one summary line. A failed call and the
 * call still running stay out of the fold, so errors and progress are never hidden; the prose is untouched.
 */
export type ToolBlock = Extract<Block, { type: "tool" }>;
export type Segment = { type: "text"; text: string } | { type: "tool"; block: ToolBlock } | { type: "fold"; tools: ToolBlock[] };

/** a call that must stay visible: it failed, or it is the one running right now */
export const pinned = (b: ToolBlock, live: boolean) => b.ok === false || (b.ok === undefined && live);

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

/** "7 tool calls · Bash ×5 Read ×2", names in order of first use */
export function foldLabel(tools: ToolBlock[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const names = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(" ");
  return `${tools.length} tool call${tools.length === 1 ? "" : "s"} · ${names}`;
}

/** the per-chat choice wins; otherwise the global setting; otherwise quiet */
export const showToolCalls = (chat: { showToolCalls?: boolean }, global: boolean | undefined) => chat.showToolCalls ?? global ?? false;
