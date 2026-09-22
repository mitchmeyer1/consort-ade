/**
 * Agents end a turn with suggested next prompts. Codex writes its own directive,
 * `:codex-followup[Label]{prompt="…"}`, and Claude has no native form, so the shared prompt
 * asks both for `[followup: label | prompt]`. Either shape is lifted out of the prose here and
 * rendered as chips that send the prompt; the transcript keeps the raw text.
 */
export type Followup = { label: string; prompt: string };

export const FOLLOWUP_PROMPT = `When the work suggests a natural next step, end your reply with up to three follow-up suggestions, each on its own line as [followup: short label | the full prompt to send]. The label is a few words; the prompt is what the user would type to ask for it. Offer only work the user could plausibly want next, and offer none when there is nothing to add.`;

const MAX_FOLLOWUPS = 4;
const MAX_LABEL = 60;

// :codex-followup[Label]{prompt="…"} — a Markdown directive; attributes are key="value" pairs
const CODEX_FOLLOWUP = /:codex-followup\[([^\]\n]*)\]\{([^}]*)\}/g;
// :codex-file-citation{path="…" sheet="…" range="…"} — a source pointer the chat can show as a file link
const CODEX_CITATION = /:codex-file-citation\{([^}]*)\}/g;
// [followup: label | prompt] — the Consort marker, prompt optional
const CONSORT_FOLLOWUP = /\[followup:\s*([^\]|\n]+?)\s*(?:\|\s*([^\]\n]+?))?\s*\]/gi;
// a list item or paragraph left holding nothing once its directive is gone
const EMPTY_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]*$\n?/gm;

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))/g)) {
    out[m[1]] = (m[2] ?? m[3] ?? m[4] ?? "").replace(/\\(["'\\])/g, "$1");
  }
  return out;
}

const tidy = (s: string) => s.trim().replace(/\s+/g, " ");

/** a citation becomes an ordinary Markdown file link, sheet and range kept in the label */
export function citationLink(raw: string): string {
  const a = attrs(raw);
  if (!a.path) return "";
  const name = a.path.split("/").pop() || a.path;
  const where = [a.sheet, a.range].filter(Boolean).join(" ");
  return `[${where ? `${name} · ${where}` : name}](<${a.path}>)`;
}

/** lift every follow-up out of an assistant text block; the prose that remains is what the chat renders */
export function parseFollowups(text: string): { text: string; followups: Followup[] } {
  const found: Followup[] = [];
  const add = (label: string, prompt: string) => {
    const l = tidy(label).slice(0, MAX_LABEL), p = tidy(prompt);
    if (!l && !p) return;
    found.push({ label: l || p.slice(0, MAX_LABEL), prompt: p || l });
  };
  let rest = text
    .replace(CODEX_FOLLOWUP, (_, label: string, raw: string) => { add(label, attrs(raw).prompt ?? ""); return ""; })
    .replace(CONSORT_FOLLOWUP, (_, label: string, prompt?: string) => { add(label, prompt ?? ""); return ""; })
    .replace(CODEX_CITATION, (_, raw: string) => citationLink(raw));
  if (found.length) rest = rest.replace(EMPTY_ITEM, "").replace(/\n{3,}/g, "\n\n").trimEnd();
  const seen = new Set<string>();
  const followups = found.filter((f) => { const k = f.prompt.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, MAX_FOLLOWUPS);
  return { text: rest, followups };
}
