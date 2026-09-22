/**
 * Standing instructions: short rules the user wants every chat to follow ("respond with
 * brevity", "always answer in TypeScript"). Kept in Settings, appended to the system prompt
 * of every chat on every provider, toggled without being deleted.
 */
export type Instruction = { id: string; text: string; enabled: boolean };

export const BREVITY = "Respond with brevity. Lead with the answer, keep replies short, skip filler, preamble and restating the request.";

/** the block appended to every chat's prompt; empty when nothing is switched on */
export function instructionsPrompt(items: Instruction[] | undefined): string {
  const on = (items ?? []).map((i) => ({ ...i, text: i.text.trim() })).filter((i) => i.enabled && i.text);
  if (!on.length) return "";
  return `The user's standing instructions, set in Consort's settings for every chat. Follow them unless a specific request says otherwise:\n${on.map((i) => `- ${i.text}`).join("\n")}`;
}

/** append the standing block to a prompt, or leave the prompt alone when there is none */
export const withInstructions = (prompt: string, items: Instruction[] | undefined) => {
  const block = instructionsPrompt(items);
  return block ? `${prompt}\n\n${block}` : prompt;
};
