import type { Message } from "./types";

/**
 * Terminal history for the composer: ↑ walks back through the prompts this chat has already sent,
 * ↓ walks forward, and stepping past the newest one puts back whatever was half-typed in the box.
 * The rules live here rather than in the key handler so the caret cases stay testable.
 */

/** what the user has sent in this chat, oldest first, with an immediate repeat collapsed */
export function promptHistory(messages: Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    const text = m.blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
    if (text && text !== out[out.length - 1]) out.push(text);
  }
  return out;
}

/** where the box is in that history: `at` counts back from the newest (1 = newest), `draft` is what was typed before ↑ */
export type HistoryNav = { at: number; draft: string } | null;

/** `handled` means the key was history, not caret movement; `text`/`nav` are absent when only the key was swallowed */
export type HistoryStep = { handled: boolean; text?: string; nav?: HistoryNav };

const IGNORE: HistoryStep = { handled: false };

export function historyStep(key: "up" | "down", opts: { nav: HistoryNav; value: string; caret: number; history: string[] }): HistoryStep {
  const { nav, value, caret, history } = opts;
  if (!history.length) return IGNORE;
  if (key === "up") {
    // from inside a draft, ↑ is still caret movement: it only recalls from the first line
    if (!nav && value.slice(0, caret).includes("\n")) return IGNORE;
    const at = (nav?.at ?? 0) + 1;
    // at the oldest prompt the key is swallowed, so the caret does not jump to the top of the box
    if (at > history.length) return { handled: true };
    return { handled: true, text: history[history.length - at], nav: { at, draft: nav?.draft ?? value } };
  }
  if (!nav) return IGNORE;
  if (value.slice(caret).includes("\n")) return IGNORE; // ↓ inside a recalled multi-line prompt
  const at = nav.at - 1;
  if (at < 1) return { handled: true, text: nav.draft, nav: null };
  return { handled: true, text: history[history.length - at], nav: { ...nav, at } };
}
