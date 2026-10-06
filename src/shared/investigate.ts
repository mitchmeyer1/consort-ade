import { clickupIdFrom, githubIssueFrom, ticketRef, type ShipTicket } from "./ship.ts";

/**
 * Investigate: a read-only look at a ticket before anyone decides to build it. Consort fetches
 * the ticket, its comments and whatever it links to that Consort can reach (other ClickUp
 * tasks, GitHub issues and PRs), writes the lot into the project's root checkout as a dossier,
 * and opens a chat there that reads the dossier and the code, then reports where things
 * stand: the situation, what is done, what is left, and what nobody has answered. Links
 * Consort cannot read (Google Docs, Notion, Figma, Slack, Loom…) are listed for the user to
 * paste in. Nothing is written to the tracker and no branch is cut.
 */

export const INVESTIGATIONS_DIR = ".consort/investigations";

/** the project page's one-line answer to "what is Investigate" */
export const INVESTIGATE_BLURB = "Read a ticket before building it. Consort gathers the ticket, its comments, linked items and the code, then briefs you: situation, progress, to-dos, open questions. Nothing is changed.";

export type DossierComment = { author: string; at: string; text: string };
export type LinkedItem = {
  /** what it is, in the tracker's terms */
  kind: "clickup task" | "clickup subtask" | "github issue" | "github pr";
  ref: string;
  url: string;
  title?: string;
  status?: string;
  /** the first part of its description, enough to know what it is about */
  excerpt?: string;
};
export type Dossier = {
  ticket: ShipTicket;
  body: string;
  status?: string;
  assignees: string[];
  comments: DossierComment[];
  linked: LinkedItem[];
  /** links in the ticket and its comments that Consort could not read; the chat asks the user for these */
  unreadable: string[];
  fetchedAt: number;
};

export const investigationFolder = (t: ShipTicket) => `${INVESTIGATIONS_DIR}/${t.source}-${t.id.toLowerCase()}`;
export const dossierFile = (t: ShipTicket) => `${investigationFolder(t)}/DOSSIER.md`;
export const investigationChatName = (t: ShipTicket) => `investigate · ${ticketRef(t)} · ${t.title}`.slice(0, 80);

const URL_RE = /https?:\/\/[^\s<>()\]"']+/g;
/** every link in a text, once, with trailing punctuation shed */
export const extractLinks = (text: string): string[] => [...new Set((text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")))];

export type LinkKind = { kind: "clickup"; id: string } | { kind: "github-issue"; repo?: string; number: number } | { kind: "github-pr"; repo?: string; number: number } | { kind: "other"; url: string };
export function classifyLink(url: string): LinkKind {
  const pr = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(url);
  if (pr) return { kind: "github-pr", repo: pr[1], number: Number(pr[2]) };
  const issue = githubIssueFrom(url);
  if (issue && /github\.com/.test(url)) return { kind: "github-issue", repo: issue.repo, number: issue.number };
  if (/clickup\.com\/t\//.test(url)) { const id = clickupIdFrom(url); if (id) return { kind: "clickup", id }; }
  return { kind: "other", url };
}

const excerpt = (s: string | undefined, max = 600) => { const t = (s ?? "").trim().replace(/\r\n/g, "\n"); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** the dossier as one Markdown file: the ticket, then its discussion, then what it links to */
export function dossierMarkdown(d: Dossier): string {
  const t = d.ticket;
  const where = t.source === "github" ? `GitHub issue #${t.id}${t.repo ? ` in ${t.repo}` : ""}` : `ClickUp task ${t.id}`;
  const head = [`- Source: ${where}`, `- URL: ${t.url}`, d.status ? `- Status in the tracker: ${d.status}` : "", d.assignees.length ? `- Assignees: ${d.assignees.join(", ")}` : "", `- Fetched by Consort: ${new Date(d.fetchedAt).toISOString()}`].filter(Boolean);
  const comments = d.comments.length
    ? d.comments.map((c) => `### ${c.author || "someone"} · ${c.at}\n\n${c.text.trim() || "_(empty)_"}`).join("\n\n")
    : "_No comments._";
  const linked = d.linked.length
    ? d.linked.map((l) => `### ${l.kind} ${l.ref}${l.title ? ` — ${l.title}` : ""}\n\n- URL: ${l.url}${l.status ? `\n- Status: ${l.status}` : ""}${l.excerpt ? `\n\n${l.excerpt}` : ""}`).join("\n\n")
    : "_Nothing linked that Consort could read._";
  const unreadable = d.unreadable.length ? d.unreadable.map((u) => `- ${u}`).join("\n") : "_None._";
  return `# ${t.title}\n\n${head.join("\n")}\n\n## Description\n\n${d.body.trim() || "_The ticket has no description._"}\n\n## Comments (${d.comments.length})\n\n${comments}\n\n## Linked items Consort read (${d.linked.length})\n\n${linked}\n\n## Links Consort could not read\n\nThese need the user: ask for the content, or for the gist, before treating them as unknown.\n\n${unreadable}\n`;
}

export type InvestigatePromptInput = { ticket: ShipTicket; dossierPath: string; projectName: string; worktreePath: string; unreadable: string[] };

/** the brief's shape; the chat ends with this every time it reports */
export const BRIEF_SECTIONS = ["Situation", "Progress so far", "Remaining to-dos", "Unanswered questions"] as const;

export function investigatePrompt(i: InvestigatePromptInput): string {
  const ask = i.unreadable.length
    ? `\n\nConsort could not read ${i.unreadable.length} link${i.unreadable.length === 1 ? "" : "s"} in the ticket (they are listed at the end of the dossier). Name each one in your first reply and ask the user to paste its content or summarise it; until they do, treat what it holds as an open question, not as absent.`
    : "";
  return `Investigate ${ticketRef(i.ticket)} "${i.ticket.title}" for ${i.projectName}. This is a read-only investigation: no branch, no code changes, nothing written to the tracker. The deliverable is a brief the user can act on.

Start with the dossier Consort wrote at ${i.dossierPath}: the ticket, its comments, and the linked tasks, issues and PRs Consort could reach. You have no tracker access of your own; the dossier is the tracker. For GitHub links you can go further with \`gh\` (issue view, pr view, pr diff) from ${i.worktreePath}.${ask}

Then read the code in ${i.worktreePath} (the project's root checkout, on its default branch) for the structures the ticket touches: the modules, tables, jobs, routes and tests that already exist, and anything that already does part of what the ticket asks. Name them with paths. Check \`git log\` and open PRs for work already done toward it.

Report in these four sections, in this order, with these headings:
1. **Situation** — what the ticket asks for in one paragraph, who asked, what it depends on, and what exists in the code today that it builds on. Plain words, concrete names.
2. **Progress so far** — what is already done: merged PRs, open PRs, commits, comments that settle something, subtasks closed. Each with a reference. "Nothing yet" is a fine answer.
3. **Remaining to-dos** — the work left, as a checklist, in a sensible order, each one or two lines. Include the decisions that must be made before building.
4. **Unanswered questions** — what the ticket, its comments and the code do not settle, each as a question, with your recommended answer where you have one. Include every link you could not read.

Keep it under a page. Cite the dossier by section and the code by path. When the user pastes missing content or answers a question, fold it in and reissue the brief with the same four headings, marking what changed.`;
}
