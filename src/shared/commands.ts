/** a slash command the composer can complete: the SDK's skills and commands, plus Consort's own */
export type SlashEntry = { name: string; description: string; argumentHint?: string; native?: boolean };

/** Consort runs the SDK, so a chat has no CLI built-ins; these two are emulated (clear) or passed through (compact) */
export const NATIVE_COMMANDS: SlashEntry[] = [
  { name: "clear", description: "Start a fresh session for this chat. The transcript stays on screen; the model forgets it.", native: true },
  { name: "compact", description: "Compact the session's context (the CLI's own /compact).", argumentHint: "[focus]", native: true },
  { name: "ship", description: "Run the feature pipeline here: the next step, approve, pr-loop, \"<feedback>\", pause; or new <idea> to start one.", argumentHint: "[new <idea> | approve | pr-loop | \"<feedback>\" | pause]", native: true },
];

/** the command being typed, only while the composer holds a lone /word (a space after it means arguments, no popup) */
export function commandQuery(text: string): string | undefined {
  const m = /^\/([\w:-]*)$/.exec(text);
  return m ? m[1].toLowerCase() : undefined;
}

/** prefix matches first, then names that merely contain the query; Consort's own commands are always in the pool */
export function filterCommands(entries: SlashEntry[], query: string): SlashEntry[] {
  const seen = new Set<string>();
  const all = [...NATIVE_COMMANDS, ...entries].filter((e) => !seen.has(e.name) && seen.add(e.name));
  const byName = (a: SlashEntry, b: SlashEntry) => a.name.localeCompare(b.name);
  const starts = all.filter((e) => e.name.toLowerCase().startsWith(query)).sort(byName);
  const within = all.filter((e) => !starts.includes(e) && e.name.toLowerCase().includes(query)).sort(byName);
  return [...starts, ...within];
}

export const completeCommand = (entry: SlashEntry) => `/${entry.name} `;
export const isClearCommand = (text: string) => text.trim() === "/clear";
export const CLEAR_DIVIDER = "Context cleared · the model sees nothing above this line";
