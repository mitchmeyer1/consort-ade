/**
 * Every /ship message ends with `Stage: … · Ticket: … · Next: /ship <id> [args]`; several commands can follow
 * "Next:" joined by "or", each maybe with a remark in parentheses. The commands become chips at the end of a
 * ship chat's turn; clicking one clears the context and sends it, the clear-then-resume habit in one click.
 */
export type NextCommand = { command: string; label: string; needsFeedback: boolean };

const FEEDBACK = /"<feedback>"|<feedback>|"<[^>]*feedback[^>]*>"/i;
const FOOTER = /Stage:[^\n]*·\s*Ticket:[^\n]*·\s*Next:\s*([^\n]+)/g;

export function parseNextCommands(text: string): NextCommand[] {
  const footers = [...text.matchAll(FOOTER)];
  const tail = footers.at(-1)?.[1];
  if (!tail) return [];
  const out: NextCommand[] = [];
  for (const part of tail.replace(/`/g, "").split(/\s+or\s+/i)) {
    const command = part.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim().replace(/[.,;]+$/, "");
    if (!/^\/ship(\s|$)/.test(command) || out.some((o) => o.command === command)) continue;
    out.push({ command, label: command, needsFeedback: FEEDBACK.test(command) });
  }
  return out;
}

const quote = (s: string) => `"${s.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** the feedback placeholder replaced by the user's text, quoted as the skill expects */
export const fillNextCommand = (command: string, text: string) => command.replace(FEEDBACK, quote(text));
