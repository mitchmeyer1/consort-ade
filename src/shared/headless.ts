import { MODELS, type Provider } from "./types.ts";
import { byCapability, rankModel } from "./modelTiers.ts";

/**
 * Rules for running /ship with nobody at the keyboard (consort-cli). The agent decides the
 * obvious itself and raises only material questions, which the CLI relays over Slack; the
 * pipeline claims tickets so two machines never take the same one; reviews rotate across the
 * models available; a PR is "ready" on a fixed test. Everything here is pure so it can be
 * tested without Slack, ClickUp, GitHub or an agent.
 */

/** one question for the person, raised by the agent as a marker line; the CLI strips these from what it posts */
export const ASK_USER_MARKER = /\[ask-user:\s*([^\]]+?)\s*\]\s*/g;

export function parseAskUser(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ASK_USER_MARKER)) { const q = m[1].trim(); if (q && !out.includes(q)) out.push(q); }
  return out;
}
export const stripAskUser = (text: string) => text.replace(ASK_USER_MARKER, "").replace(/\n{3,}/g, "\n\n").trim();

/** appended to every headless /ship turn */
export const HEADLESS_RULES = `## Headless run: nobody is watching this chat live

Consort is running this feature unattended on a server. There is no user in the chat; the person who owns the ticket is reachable only through Slack, and only for questions that matter.
- Decide anything straightforward yourself: naming, file placement, which existing pattern to follow, test shape, obvious defaults. Record each such decision as one line under "Assumptions" in ${"`"}.consort/ship/GRILLING.md${"`"} and in the spec, so a reader can overturn it later.
- Ask only when the answer changes scope, cost, data, security, or user-facing behaviour in a way the ticket does not settle and the code does not imply. Put each such question on its own line as ${"`"}[ask-user: <the question, with your recommended answer>]${"`"}, then end your turn. Consort relays them over Slack and sends the answers back as the next message. Never block on anything you did not mark this way.
- Where a handler tells you to ask the user for a go-ahead, confirmation, or to "present and wait", proceed instead, noting what you would have asked.
- Never argue with a human reviewer on the PR. Apply what is clearly right; where you disagree or the request conflicts with the ticket, say so neutrally in one reply on the thread and raise it with ${"`"}[ask-user: …]${"`"}. The owner decides.
- Never merge. Never force-push. Never amend a pushed commit.
- Research is allowed and expected: search and read the web (WebSearch and WebFetch, or Codex's web search) for library docs, APIs, error messages and prior art whenever the repo does not answer. Cite what you relied on in the spec or the PR body.
- Nothing will ever ask you for permission here; every tool call runs. Act with that care: no destructive git, no secrets in commits, no changes outside this worktree.
- Keep replies short and factual: what you did, what changed, what is next. The owner reads them as Slack messages.`;

/** the Grilling handler when there is no one to interview */
export const GRILLING_HEADLESS = `## This turn: Grilling, headless — settle the idea, then write the spec

The ticket's text is the idea. Read ${"`"}.consort/ship/TICKET.md${"`"} (the full ticket, comments included) and ${"`"}.consort/ship/GRILLING.md${"`"} if it exists (earlier rounds and the owner's answers). Explore the repo for everything a file could answer.

Map the idea as a design tree and walk it. Decide every branch yourself where the ticket, the code or common practice settles it; write those decisions under "## Assumptions" in GRILLING.md. Only the decisions that are material and genuinely open go to the owner, each as ${"`"}[ask-user: Q — recommended: A]${"`"}; keep them few and precise, and end the turn after writing them.

When no open question remains, write ${"`"}.consort/ship/SPEC.md${"`"} in this same turn, sections in this order: Problem, Solution, User stories (a long numbered list, "As a <actor>, I want <feature>, so that <benefit>"), Implementation decisions, Testing decisions, Out of scope, Open questions (only real ones), Assumptions (copied from GRILLING.md). Then emit ${"`"}[ship-spec: .consort/ship/SPEC.md]${"`"}, ${"`"}[ship-stage: Spec'd | Spec written headless in <n> round(s).]${"`"} and ${"`"}[ship-next: /ship]${"`"}.`;

/** what the PR-monitor turn does when humans have commented */
export const RESPOND_TO_REVIEW = (unresolved: { author: string; path?: string; line?: number; body: string; url: string }[]) => `## This turn: answer the humans on the PR

Reviewers left ${unresolved.length} unresolved thread${unresolved.length === 1 ? "" : "s"}. For each one below: if the request is clear and right, make the change, commit, push, reply on the thread with what changed, and resolve it (${"`"}gh api graphql${"`"} resolveReviewThread). If it is unclear or you disagree, reply once, neutrally, with the trade-off, do not resolve it, and raise it as ${"`"}[ask-user: …]${"`"} quoting the reviewer. Run the repo's checks before pushing. End with one line per thread: resolved / asked / declined.

${unresolved.map((t, i) => `${i + 1}. ${t.author}${t.path ? ` on ${t.path}${t.line ? `:${t.line}` : ""}` : ""} — ${t.url}\n${t.body.trim().split("\n").map((l) => `   > ${l}`).join("\n")}`).join("\n\n")}`;

/** the matching rules of a scan job: every listed rule must hold for the ticket to be taken */
export type SourceFilters = {
  /** ClickUp tags or GitHub labels, any of which must be present */
  tags?: string[];
  /** ticket statuses (ClickUp) or states (GitHub) it may be in, case-insensitive */
  statuses?: string[];
  /** substrings the title must contain (all), case-insensitive */
  nameIncludes?: string[];
  /** substrings the title must not contain */
  nameExcludes?: string[];
  /** only tickets assigned to one of these logins/emails */
  assignees?: string[];
};
export type ScannedTicket = { id: string; title: string; status?: string; tags: string[]; assignees: string[]; url: string; updatedAt?: number };

const norm = (s: string) => s.trim().toLowerCase();
export function matchesFilters(t: ScannedTicket, f: SourceFilters): boolean {
  const title = norm(t.title);
  if (f.tags?.length && !f.tags.some((tag) => t.tags.map(norm).includes(norm(tag)))) return false;
  if (f.statuses?.length && !f.statuses.map(norm).includes(norm(t.status ?? ""))) return false;
  if (f.nameIncludes?.length && !f.nameIncludes.every((s) => title.includes(norm(s)))) return false;
  if (f.nameExcludes?.some((s) => title.includes(norm(s)))) return false;
  if (f.assignees?.length && !f.assignees.some((a) => t.assignees.map(norm).includes(norm(a)))) return false;
  return true;
}

/**
 * The claim: a comment on the ticket naming the host and time, written before any work starts.
 * Another consort-cli reads it and skips the ticket. A claim older than `staleMs` with no later
 * activity is treated as abandoned so a crashed box does not lock a ticket for ever.
 */
export const CLAIM_PREFIX = "[consort-claim";
export const claimComment = (host: string, at: number) => `${CLAIM_PREFIX} host=${host} at=${new Date(at).toISOString()}] Consort is working on this ticket from ${host}. Other Consort instances will skip it.`;
export function claimOf(comments: { text: string; at?: number }[]): { host: string; at: number } | undefined {
  let found: { host: string; at: number } | undefined;
  for (const c of comments) {
    const m = /\[consort-claim host=([^\s\]]+) at=([^\s\]]+)\]/.exec(c.text);
    if (!m) continue;
    const at = Date.parse(m[2]);
    if (!found || at > found.at) found = { host: m[1], at: Number.isFinite(at) ? at : c.at ?? 0 };
  }
  return found;
}
export const claimedByOther = (comments: { text: string; at?: number }[], host: string, now: number, staleMs = 3 * 24 * 3_600_000) => {
  const claim = claimOf(comments);
  return !!claim && claim.host !== host && now - claim.at < staleMs;
};

/**
 * Which model reviews which round. Round 1 goes to the other provider than the builder when
 * there is one (a second pair of eyes with different training), round 2 to the strongest
 * Claude, round 3 to the next Claude family down (Opus under Fable). With one provider the
 * rounds alternate between its top two models.
 */
export type ReviewPick = { provider: Provider; model: string };
export function reviewRotation(available: Partial<Record<Provider, string[]>>, rounds = 3): ReviewPick[] {
  const claude = byCapability(available.claude?.length ? available.claude : []);
  const codex = byCapability(available.codex?.length ? available.codex : []);
  const out: ReviewPick[] = [];
  const nextFamily = (list: string[]) => list.find((m) => rankModel(m) < rankModel(list[0])) ?? list[1] ?? list[0];
  for (let r = 1; r <= rounds; r++) {
    if (claude.length && codex.length) {
      out.push(r === 1 ? { provider: "codex", model: codex[0] } : r === 2 ? { provider: "claude", model: claude[0] } : { provider: "claude", model: nextFamily(claude) });
    } else if (claude.length) out.push({ provider: "claude", model: r % 2 ? claude[0] : nextFamily(claude) });
    else if (codex.length) out.push({ provider: "codex", model: r % 2 ? codex[0] : nextFamily(codex) });
  }
  return out;
}
export const seedModels = (): Record<Provider, string[]> => ({ claude: [...MODELS.claude], codex: [...MODELS.codex] });

/** the PR as the monitor reads it */
export type PrState = {
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "";
  approvals: string[];
  unresolved: { author: string; path?: string; line?: number; body: string; url: string; id: string; createdAt: string }[];
  ci: "pass" | "fail" | "pending" | "none";
  requestedReviewers: string[];
};
export type Readiness = { ready: boolean; reasons: string[] };
/** ready to merge: at least one human approval, nothing requested-changes, no unresolved threads, CI green */
export function prReadiness(pr: PrState, botLogins: string[] = []): Readiness {
  const reasons: string[] = [];
  if (pr.state !== "OPEN") reasons.push(`PR is ${pr.state.toLowerCase()}`);
  if (pr.isDraft) reasons.push("PR is a draft");
  const human = pr.approvals.filter((a) => !botLogins.includes(a));
  if (!human.length) reasons.push("no human approval yet");
  if (pr.reviewDecision === "CHANGES_REQUESTED") reasons.push("changes requested");
  if (pr.unresolved.length) reasons.push(`${pr.unresolved.length} unresolved thread${pr.unresolved.length === 1 ? "" : "s"}`);
  if (pr.ci === "fail") reasons.push("CI failing");
  if (pr.ci === "pending") reasons.push("CI still running");
  return { ready: reasons.length === 0, reasons };
}

/** the people who touch the files this branch changed most, from `git shortlog -sne -- <paths>`, minus the bots and the owner */
export function suggestReviewers(shortlog: string, exclude: string[], max = 2): string[] {
  const rows = shortlog.split("\n").map((l) => /^\s*(\d+)\s+(.+?)\s+<([^>]+)>/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ n: Number(m[1]), name: m[2], email: m[3] }))
    .filter((r) => !/\[bot\]|noreply@anthropic|github-actions|dependabot/i.test(`${r.name} ${r.email}`))
    .filter((r) => !exclude.some((x) => x && (r.email.toLowerCase() === x.toLowerCase() || r.name.toLowerCase() === x.toLowerCase())));
  rows.sort((a, b) => b.n - a.n);
  return rows.slice(0, max).map((r) => githubLoginOf(r.email) ?? r.name);
}
/** "12345+someone@users.noreply.github.com" → "someone"; anything else is unknown */
export const githubLoginOf = (email: string) => /^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i.exec(email)?.[1];

/** the Slack reply we wait for: the owner's first message in the thread after the question */
export function replyAfter(messages: { ts: string; user?: string; text?: string; bot_id?: string }[], afterTs: string, userId: string): string | undefined {
  const after = Number(afterTs);
  return messages.filter((m) => !m.bot_id && m.user === userId && Number(m.ts) > after && (m.text ?? "").trim()).sort((a, b) => Number(a.ts) - Number(b.ts))[0]?.text?.trim();
}

/** the one-line Slack messages the pipeline posts */
export const slackLines = {
  claimed: (title: string, url: string, branch: string) => `Picked up *${title}* (<${url}|ticket>). Working on branch \`${branch}\`.`,
  stage: (stage: string, note?: string) => `→ *${stage}*${note ? ` — ${note}` : ""}`,
  question: (qs: string[], url: string) => `I need you on ${qs.length === 1 ? "one thing" : `${qs.length} things`} (<${url}|ticket>). Reply in this thread; one message answering all of them is fine.\n${qs.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
  pr: (url: string) => `Draft PR open: ${url}`,
  review: (round: number, model: string, findings: number) => `Review round ${round} on \`${model}\`: ${findings} finding${findings === 1 ? "" : "s"}, fixing the real ones.`,
  reviewers: (logins: string[]) => `Asked ${logins.map((l) => `@${l}`).join(", ")} to review.`,
  ready: (url: string) => `*Ready to merge.* Approved, no open threads, CI green: ${url}\nI will not merge; that is yours.`,
  stuck: (why: string) => `I am stuck: ${why}. Reply here with what to do, or release the ticket with \`consort-cli tasks release\`.`,
};

/**
 * The account pool. A task sticks to one account per provider until that account hits a usage
 * limit; then it moves to the least recently used account of the same provider that is not
 * blocked, and its session starts over (the stage handlers are resumable from disk). Blocks
 * expire when the provider says the window resets, or after an hour when it does not say.
 */
export type PoolAccount = { id: string; provider: Provider; blockedUntil?: number; lastUsedAt?: number };
export function pickAccount<A extends PoolAccount>(accounts: A[], provider: Provider, now: number, prefer?: string, exclude: string[] = []): A | undefined {
  const usable = accounts.filter((a) => a.provider === provider && !exclude.includes(a.id) && !(a.blockedUntil && a.blockedUntil > now));
  const sticky = prefer ? usable.find((a) => a.id === prefer) : undefined;
  if (sticky) return sticky;
  return usable.sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))[0];
}
/** when the soonest blocked account of the provider frees up, for "every account is out" */
export const earliestUnblock = (accounts: PoolAccount[], provider: Provider, now: number) => {
  const times = accounts.filter((a) => a.provider === provider && a.blockedUntil && a.blockedUntil > now).map((a) => a.blockedUntil!);
  return times.length ? Math.min(...times) : undefined;
};
export const DEFAULT_BLOCK_MS = 60 * 60_000;

/** the dashboard keeps finished tasks on screen for a while, then drops them */
export const VIEW_RETENTION_MS = 2 * 60 * 60_000;
export const FINISHED: readonly string[] = ["ready", "done", "failed", "released"];
export function visibleTasks<T extends { status: string; finishedAt?: number; updatedAt: number }>(tasks: T[], now: number, retention = VIEW_RETENTION_MS): T[] {
  return tasks.filter((t) => !FINISHED.includes(t.status) || now - (t.finishedAt ?? t.updatedAt) < retention);
}
/** "3m", "2h 05m", "1d 4h" */
export function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** what the setup wizard accepts for a ClickUp list: the list's URL or its bare id */
export const clickupListIdFrom = (text: string): string | undefined => {
  const t = text.trim();
  const m = /\/li\/(\d+)/.exec(t) ?? /^(\d{6,})$/.exec(t);
  return m?.[1];
};
/** a Slack member id as people paste it: bare, as a mention, or at the end of a profile URL */
export const slackUserIdFrom = (text: string): string | undefined => /\b([UW][A-Z0-9]{6,})\b/.exec(text.trim().toUpperCase())?.[1];
/** "1,3" or "to do,backlog" against a list of names → the chosen names, once each, unknown ones dropped */
export function chooseFrom(answer: string, options: string[]): string[] {
  const picks = answer.split(",").map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of picks) {
    const n = Number(p);
    const name = Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : options.find((o) => o.toLowerCase() === p.toLowerCase());
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
