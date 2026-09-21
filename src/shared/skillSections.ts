/**
 * A resumed chat rebuilds its context from a digest that keeps only the head of the first
 * prompt, so a long skill loses its tail. The tail is where the deliverable lives. These
 * pull named "## " sections back out of the original prompt so a resume can re-attach them.
 */

/** the sections whose "## " heading matches, each running to the next "## " heading, in document order */
export function skillSections(text: string, headings: RegExp[]) {
  const parts = text.split(/^(?=## )/m);
  return parts.filter((p) => headings.some((h) => h.test(p.split("\n")[0] ?? ""))).map((p) => p.trimEnd()).join("\n\n");
}

/** the review skill's file schema and closing-link rule, the two sections a resumed review must not lose */
export const reviewDeliverable = (skillText: string) => skillSections(skillText, [/^## Phase 5\b/, /^## Phase 6\b/]);

/** the prompt a review chat was started with: the first user turn carries the whole skill */
export function firstPrompt(chat: { messages: { role: string; blocks: { type: string; text?: string }[] }[] }) {
  return chat.messages.find((m) => m.role === "user")?.blocks.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("\n") ?? "";
}
