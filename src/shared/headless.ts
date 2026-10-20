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
- If the business purpose, acceptance criteria, or design is materially unclear, ask the owner before building or changing behavior.
- Ask only when the answer changes scope, cost, data, security, or user-facing behaviour in a way the ticket does not settle and the code does not imply. Put each such question on its own line as ${"`"}[ask-user: <the question, with your recommended answer>]${"`"}, then end your turn. Consort relays them over Slack and sends the answers back as the next message. Never block on anything you did not mark this way.
- Where a handler tells you to ask the user for a go-ahead, confirmation, or to "present and wait", proceed instead, noting what you would have asked.
- Never argue with a human reviewer on the PR. Apply what is clearly right; where you disagree or the request conflicts with the ticket, say so neutrally in one reply on the thread and raise it with ${"`"}[ask-user: …]${"`"}. The owner decides.
- Never merge. Never force-push. Never amend a pushed commit.
- Research is allowed and expected: search and read the web (WebSearch and WebFetch, or Codex's web search) for library docs, APIs, error messages and prior art whenever the repo does not answer. Cite what you relied on in the spec or the PR body.
- Nothing will ever ask you for permission here; every tool call runs. Act with that care: no destructive git, no secrets in commits, no changes outside this worktree.
- Never start something in the background and end your turn to wait for it. Nothing will notify you: when your turn ends every background process is killed, and the next turn has to start it over (a full test suite, three times, is how a 10-minute task takes an hour). Run long commands in the foreground with a generous timeout and read their result in the same turn. Run only the checks that prove the change: the touched packages' tests, typecheck, lint. Never run the whole repository's test suite; on a real codebase that is twenty minutes of database-backed tests, and the PR's CI runs it anyway (the readiness check waits for CI to be green, and the review rounds read its result).
- Keep replies short and factual: what you did, what changed, what is next. The owner reads them as Slack messages.`;

/** the Grilling handler when there is no one to interview */
export const GRILLING_HEADLESS = `## This turn: Grilling, headless — settle the idea, then write the spec

The ticket's text is the idea. Read ${"`"}.consort/ship/TICKET.md${"`"} (the full ticket, comments included) and ${"`"}.consort/ship/GRILLING.md${"`"} if it exists (earlier rounds and the owner's answers). Explore the repo for everything a file could answer.

Map the idea as a design tree and walk it. Decide every branch yourself where the ticket, the code or common practice settles it; write those decisions under "## Assumptions" in GRILLING.md. Only the decisions that are material and genuinely open go to the owner, each as ${"`"}[ask-user: Q — recommended: A]${"`"}; keep them few and precise, and end the turn after writing them.

When no open question remains, write ${"`"}.consort/ship/SPEC.md${"`"} in this same turn, sections in this order: Problem, Solution, User stories (a long numbered list, "As a <actor>, I want <feature>, so that <benefit>"), Implementation decisions, Testing decisions, Out of scope, Open questions (only real ones), Assumptions (copied from GRILLING.md). Then emit ${"`"}[ship-spec: .consort/ship/SPEC.md]${"`"}, ${"`"}[ship-stage: Spec'd | Spec written headless in <n> round(s).]${"`"} and ${"`"}[ship-next: /ship]${"`"}.`;

/** what the PR-monitor turn does when humans have commented */
export const RESPOND_TO_REVIEW = (unresolved: { author: string; path?: string; line?: number; body: string; url: string }[]) => `## This turn: answer the humans on the PR

Reviewers left ${unresolved.length} unresolved thread${unresolved.length === 1 ? "" : "s"}. For each one below: if the request is clear and right, make the change, commit, push, reply on the thread with what changed, and resolve it (${"`"}gh api graphql${"`"} resolveReviewThread). If it is unclear or you disagree, reply once, neutrally, with the trade-off, do not resolve it, and raise it as ${"`"}[ask-user: …]${"`"} quoting the reviewer. For a top-level review without a thread, answer with a PR comment and do not try to resolve a thread. Run the repo's checks before pushing. End with one line per thread: resolved / asked / declined.

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
export const CLAIM_STALE_MS = 3 * 24 * 3_600_000;
/** every claim marker on the ticket, oldest first */
export function claimsOf(comments: { text: string; at?: number }[]): { host: string; at: number }[] {
  const out: { host: string; at: number }[] = [];
  for (const c of comments) {
    const m = /\[consort-claim host=([^\s\]]+) at=([^\s\]]+)\]/.exec(c.text);
    if (!m) continue;
    const at = Date.parse(m[2]);
    out.push({ host: m[1], at: Number.isFinite(at) ? at : c.at ?? 0 });
  }
  return out.sort((a, b) => a.at - b.at || a.host.localeCompare(b.host));
}
/**
 * Who holds the ticket: the earliest claim that is still fresh (under three days old). Every box
 * posts its marker and then re-reads; with "earliest wins" two boxes that raced agree on the same
 * winner, and a box that lost backs off. Stale markers are abandoned work and count for nothing.
 */
export const claimOf = (comments: { text: string; at?: number }[], now = Date.now(), staleMs = CLAIM_STALE_MS) => claimsOf(comments).find((c) => now - c.at < staleMs);
export const claimedByOther = (comments: { text: string; at?: number }[], host: string, now: number, staleMs = CLAIM_STALE_MS) => {
  const claim = claimOf(comments, now, staleMs);
  return !!claim && claim.host !== host;
};
/** after posting our marker: do we hold the ticket? false when an earlier fresh marker from another box is there */
export const claimHeld = (comments: { text: string; at?: number }[], host: string, now: number, staleMs = CLAIM_STALE_MS) => claimOf(comments, now, staleMs)?.host === host;

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
  feedback?: PrState["unresolved"];
  ci: "pass" | "fail" | "pending" | "none";
  requestedReviewers: string[];
};
export type Readiness = { ready: boolean; reasons: string[] };
/** ready to merge: at least one human approval, nothing requested-changes, no unresolved threads, CI green */
export function prReadiness(pr: PrState, botLogins: string[] = []): Readiness {
  const reasons: string[] = [];
  if (pr.state !== "OPEN") reasons.push(`PR is ${pr.state.toLowerCase()}`);
  if (pr.isDraft) reasons.push("PR is a draft");
  const human = pr.approvals.filter((a) => !botLogins.includes(a) && !/\[bot\]$/.test(a));
  if (!human.length) reasons.push("no human approval yet");
  if (pr.reviewDecision === "CHANGES_REQUESTED") reasons.push("changes requested");
  if (pr.unresolved.length) reasons.push(`${pr.unresolved.length} unresolved thread${pr.unresolved.length === 1 ? "" : "s"}`);
  if (pr.ci === "fail") reasons.push("CI failing");
  if (pr.ci === "pending") reasons.push("CI still running");
  if (pr.ci === "none") reasons.push("no CI checks reported");
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
/** Try the requested provider first, then the other provider before waiting for a reset. */
export function pickTurnAccount<A extends PoolAccount>(accounts: A[], provider: Provider, now: number, preferred: Partial<Record<Provider, string>>): A | undefined {
  return pickAccount(accounts, provider, now, preferred[provider])
    ?? pickAccount(accounts, provider === "claude" ? "codex" : "claude", now, preferred[provider === "claude" ? "codex" : "claude"]);
}
/** when the soonest blocked account of the provider frees up, for "every account is out" */
export const earliestUnblock = (accounts: PoolAccount[], provider: Provider, now: number) => {
  const times = accounts.filter((a) => a.provider === provider && a.blockedUntil && a.blockedUntil > now).map((a) => a.blockedUntil!);
  return times.length ? Math.min(...times) : undefined;
};
export const DEFAULT_BLOCK_MS = 60 * 60_000;

/**
 * Where a task is on the worker's road, for the dashboard: "3/9" and the step after it. The
 * steps are the ones pipeline.ts walks in order: the local environment, the /ship stages
 * (grilling, build, test), one self-review round per model in the rotation, the evidence, then
 * the watch on the PR. `reviews` is the rotation length (3 unless the scanner says otherwise).
 */
export type TaskStep = { n: number; total: number; name: string; next: string };
export function taskStep(t: { status: string; envReadyAt?: number; reviewsDone: number; feature: { stage: string; built?: boolean; evidenceAt?: number } }, reviews = 3): TaskStep {
  const names = ["Environment", "Grilling", "Build", "Test", ...Array.from({ length: reviews }, (_, i) => `Review ${i + 1}`), "Evidence", "Watch PR"];
  const total = names.length;
  const stage = t.feature.stage;
  let n: number;
  if (t.status === "ready" || t.status === "done") n = total + 1;
  else if (t.status === "monitoring") n = total;
  else if (!t.envReadyAt) n = 1;
  else if (stage === "Grilling") n = 2;
  else if (stage === "Spec'd" || (stage === "Implementing" && !t.feature.built)) n = 3;
  else if (stage === "Implementing" || stage === "Ready to Test" || stage === "Revising") n = 4;
  else if (t.reviewsDone < reviews) n = 5 + t.reviewsDone;
  else if (!t.feature.evidenceAt) n = 5 + reviews;
  else n = total;
  const name = n > total ? (t.status === "done" ? "Done" : "Ready to merge") : names[n - 1];
  const next = n > total ? "" : n === total ? "Ready to merge" : names[n];
  return { n: Math.min(n, total), total, name, next };
}

/**
 * The STATUS cell: is the agent moving? RUNNING when the worker is alive and the log is fresh;
 * WAITING on a Slack answer; LIMIT when every account it can use is blocked; STALLED when it should
 * be running but has said nothing for a while; STOPPED when it failed or its worker is gone.
 */
export type TaskHealth = { label: "RUNNING" | "WAITING" | "LIMIT" | "STALLED" | "STOPPED" | "COMPLETED" | "DONE" | "RELEASED"; tone: "ok" | "warn" | "bad" | "off" | "complete"; note?: string };
export function taskHealth(
  t: { status: string; accountIds: Partial<Record<string, string>>; activeProvider?: Provider; activity?: string; note?: string; pauseReason?: string },
  accounts: { id: string; provider: string; blockedUntil?: number }[],
  live: { workerAlive: boolean; logAgeMs: number | undefined },
  now: number,
  stalledAfterMs = 10 * 60_000,
): TaskHealth {
  if (t.status === "ready") return { label: "COMPLETED", tone: "complete" };
  if (t.status === "done") return { label: "DONE", tone: "off" };
  if (t.status === "released") return { label: "RELEASED", tone: "off" };
  if (t.status === "failed") return { label: "STOPPED", tone: "bad", note: t.note };
  if (!live.workerAlive) return { label: "STOPPED", tone: "bad", note: t.note ?? "no worker process" };
  if (t.status === "waiting" || t.status === "monitoring") return { label: "WAITING", tone: "warn", note: t.pauseReason ?? t.note ?? (t.status === "monitoring" ? "awaiting human review or CI" : "on your Slack reply") };
  const limited = accounts.length > 0 && accounts.every((a) => a.blockedUntil && a.blockedUntil > now);
  if (limited || /accounts? at (its|their) limit/i.test(t.activity ?? "")) return { label: "LIMIT", tone: "warn", note: "every account at its usage limit" };
  if (live.logAgeMs !== undefined && live.logAgeMs > stalledAfterMs) return { label: "STALLED", tone: "warn", note: `quiet for ${Math.round(live.logAgeMs / 60_000)} min` };
  return { label: "RUNNING", tone: "ok" };
}

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

/** a ClickUp scope to watch: one list, a folder of lists, or a whole space; from the sidebar URL (/v/li/, /v/f/, /v/s/) or a bare id (a list) */
export type ClickupScope = { kind: "list" | "folder" | "space"; id: string; /** the workspace, from the URL when it had one; a space or folder scan needs it */ teamId?: string };
export const clickupScopeFrom = (text: string): ClickupScope | undefined => {
  const t = text.trim();
  const m = /(?:app\.clickup\.com\/(\d+))?\/v\/(li|l|f|s)\/(\d+)/.exec(t);
  if (m) return { kind: m[2] === "s" ? "space" : m[2] === "f" ? "folder" : "list", id: m[3], ...(m[1] ? { teamId: m[1] } : {}) };
  const bare = /^(?:(list|folder|space)[:\s]+)?(\d{6,})$/i.exec(t);
  return bare ? { kind: (bare[1]?.toLowerCase() as ClickupScope["kind"]) ?? "list", id: bare[2] } : undefined;
};
/** a saved secret as the wizard shows it back: first and last few characters only */
export const masked = (v: string) => (v.length > 12 ? `${v.slice(0, 5)}…${v.slice(-4)}` : "••••");
/** what the setup wizard accepts for a ClickUp list: the list's URL or its bare id */
export const clickupListIdFrom = (text: string): string | undefined => { const s = clickupScopeFrom(text); return s?.kind === "list" ? s.id : undefined; };
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

/**
 * Evidence: before a PR is handed to humans, the worker proves the feature works and posts the
 * proof on the PR and the ticket, each linking to the other. The agent writes a manifest of
 * items; a frontend feature gets screenshots of the running app over a seeded local database,
 * anything else gets terminal or database output, rendered to images as well as kept as text.
 */
export const EVIDENCE_DIR = ".consort/ship/evidence";
export const EVIDENCE_MANIFEST = `${EVIDENCE_DIR}/manifest.json`;
export type EvidenceItem = { title: string; image?: string; text?: string; command?: string; note?: string };
export type EvidenceCheck = { story: string; status: "passed" | "failed" | "blocked"; expected: string; observed: string; items: string[] };
export type EvidenceManifest = { status?: "passed" | "blocked"; checks?: EvidenceCheck[]; blockers?: string[]; kind: "frontend" | "backend" | "mixed"; summary: string; seeded?: string; items: EvidenceItem[] };

export function parseEvidenceManifest(raw: unknown): EvidenceManifest | undefined {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { return undefined; } }
  const r = v as Partial<EvidenceManifest> | undefined;
  if (!r || typeof r !== "object") return undefined;
  const kind = r.kind === "frontend" || r.kind === "mixed" ? r.kind : "backend";
  const items: EvidenceItem[] = (Array.isArray(r.items) ? r.items : []).flatMap((i: any) => {
    if (!i || typeof i.title !== "string" || !i.title.trim()) return [];
    const image = typeof i.image === "string" && /\.(png|jpe?g|gif|webp)$/i.test(i.image) ? i.image.replace(/^\.?\/?/, "").replace(/^\.consort\/ship\/evidence\//, "") : undefined;
    const text = typeof i.text === "string" && i.text.trim() ? i.text.trim().slice(0, 6000) : undefined;
    if (!image && !text) return [];
    return [{ title: i.title.trim(), image, text, command: typeof i.command === "string" ? i.command.trim() : undefined, note: typeof i.note === "string" ? i.note.trim() : undefined }];
  });
  const checks = Array.isArray(r.checks) ? r.checks.map((c: any): EvidenceCheck => ({ story: typeof c?.story === "string" ? c.story : "", status: c?.status === "passed" ? "passed" : c?.status === "failed" ? "failed" : "blocked", expected: typeof c?.expected === "string" ? c.expected : "", observed: typeof c?.observed === "string" ? c.observed : "", items: Array.isArray(c?.items) ? c.items.filter((t: unknown): t is string => typeof t === "string") : [] })) : undefined;
  return { ...(r.status === "passed" || r.status === "blocked" ? { status: r.status } : {}), ...(checks ? { checks } : {}), ...(Array.isArray(r.blockers) ? { blockers: r.blockers.map(String) } : {}), kind, summary: typeof r.summary === "string" ? r.summary.trim() : "", seeded: typeof r.seeded === "string" ? r.seeded.trim() : undefined, items };
}

/** A capture is not proof until every acceptance check passes and points to real output. */
export function evidenceProblems(m: EvidenceManifest | undefined): string[] {
  if (!m) return ["No readable evidence manifest was written."];
  const issues: string[] = [];
  if (m.status !== "passed") issues.push("Evidence has not passed.");
  if (m.blockers?.length) issues.push(...m.blockers);
  if (!m.summary.trim()) issues.push("Evidence needs a summary of the working result.");
  if (!m.items.length) issues.push("Evidence contains no captures or output.");
  if (m.kind !== "backend" && !m.items.some((i) => i.image)) issues.push("Frontend evidence needs screenshots of the working feature.");
  if (!m.checks?.length) issues.push("Acceptance checks are missing.");
  for (const c of m.checks ?? []) {
    if (c.status !== "passed" || !c.story.trim() || !c.expected.trim() || !c.observed.trim()) issues.push(`Acceptance check did not pass: ${c.story || "unnamed check"}`);
    if (!c.items.length || c.items.some((title) => !m.items.some((i) => i.title === title))) issues.push(`Acceptance check has no matching proof: ${c.story}`);
  }
  return issues;
}

export const EVIDENCE_PROMPT = (i: { helper: string; ticketUrl: string; prUrl: string; worktree: string; repoRoot?: string }) => `## This turn: evidence the feature works, for the people who will merge it

The PR has been through Consort's review rounds. Before it goes to human reviewers, produce proof a reviewer can look at without running anything, and write it to ${EVIDENCE_DIR}/ in this worktree with a manifest at ${EVIDENCE_MANIFEST}.

Evidence must demonstrate that the requested feature actually works, including every acceptance criterion in SPEC.md and TICKET.md. An error page, unavailable map tiles, missing API key, broken dependency, or partially working flow is a blocker, never successful evidence. Inspect every screenshot with your image-viewing tool and read every command's output. Fix what you can and capture the successful result again. Preserve diagnostics locally, but exclude failed captures from the successful manifest.

If blocked, stop and ask the owner with [ask-user: <specific blocker and what you need>]. Do not claim success or invent a workaround that changes the business requirement. For a missing credential, determine its exact env variable and the app's env-file convention from the repo. Ask the owner to add that variable to ${i.repoRoot ?? "the repository root on the Consort machine"}/.env (or the repository's documented root env file), then confirm in Slack. Never ask for a secret in Slack. Only after that confirmation, copy the required named variable from the root env file into the worktree's appropriate ignored env file, preserve unrelated settings, restart the app, and rerun the blocked flow. Never print, post, screenshot, or commit env values, and never copy the entire root env file. Do not copy production secrets that the local feature does not require.

Decide from SPEC.md and the diff whether a frontend is involved.
- **Frontend involved:** seed a local database with data that exercises the feature (use the repo's own seed or fixture scripts, migrations and docker-compose if it has them; invent plausible data where it has none), start the app locally, and take screenshots of the feature in use: the before state where it helps, each step, the result. Take them with the helper: \`node ${i.helper} <url> [width height]\` captures a page to a PNG and prints its path; move or copy each PNG into ${EVIDENCE_DIR}/ with a descriptive file name. Stop the app and any containers when done.
- **No frontend:** run the feature end to end and capture what proves it: the commands and their output, database queries and their rows, API calls and responses, test runs. Save each as text in the manifest, and also as a picture: pipe the text to \`node ${i.helper} --text "<title>" > ${EVIDENCE_DIR}/<name>.png\`, which renders it as a terminal image.
- Both when both apply.

Manifest schema (JSON):
{ "status": "passed" | "blocked", "blockers": [], "checks": [{ "story": "<acceptance criterion from SPEC.md>", "status": "passed" | "failed" | "blocked", "expected": "<required result>", "observed": "<actual result>", "items": ["<matching item title>"] }], "kind": "frontend" | "backend" | "mixed", "summary": "<two or three sentences: what was proven and how>", "seeded": "<how the local data was seeded, or omitted>",
  "items": [ { "title": "<what this shows>", "image": "<file name in ${EVIDENCE_DIR}>", "text": "<the output, for text items>", "command": "<the command run, if any>", "note": "<one line of context>" } ] }

Rules: set status to passed only when all acceptance checks passed and blockers is empty; real output only, never mocked or hand-edited; no secrets or real customer data in any capture; six to ten items is plenty; name files for what they show. Consort posts the manifest to the PR (${i.prUrl}) and the ticket (${i.ticketUrl}), each linking to the other. Reply with one line per item when done.`;

/** A fresh agent independently checks artifacts rather than trusting the capture agent's summary. */
export const VERIFY_EVIDENCE_PROMPT = `Independently verify ${EVIDENCE_MANIFEST} against .consort/ship/SPEC.md, TICKET.md, the diff, and the actual evidence files. Read every image using image tools and inspect command output. Do not trust manifest.status or prose claiming success. Require proof for every acceptance criterion, successful end-to-end behavior, and working external dependencies. API KEY REQUIRED tiles, error pages, missing credentials, failed checks, placeholder output, or unproven criteria mean evidence is blocked. Failure diagnostics do not prove a working feature. Do not edit the manifest or publish anything. If all criteria are proven, reply with exactly [evidence-approved]. Otherwise explain the concrete blockers, naming any required env variable without its value. Consort will ask the owner on Slack and retry; never waive a requirement.`;

/** the evidence as a GitHub comment: images inline, text as code blocks, the ticket linked */
export function evidenceMarkdownForPr(m: EvidenceManifest, images: Record<string, string>, ticketUrl: string, ticketRefText: string): string {
  const out = [`## Evidence`, "", m.summary || "Proof the feature works, gathered by Consort before handing the PR to reviewers.", "", `Ticket: ${ticketRefText} (${ticketUrl})${m.seeded ? `\nLocal data: ${m.seeded}` : ""}`, ""];
  m.items.forEach((it, n) => {
    out.push(`### ${n + 1}. ${it.title}`);
    if (it.note) out.push(it.note);
    if (it.command) out.push("", "```", `$ ${it.command}`, "```");
    if (it.image) out.push("", images[it.image] ? `![${it.title}](${images[it.image]})` : `_(image ${it.image} could not be published)_`);
    if (it.text) out.push("", "```", it.text, "```");
    out.push("");
  });
  out.push(`_Posted by consort-cli. The same evidence is on the ticket._`);
  return out.join("\n");
}

/** the evidence as a ticket comment: plain text, image links listed, the PR linked */
export function evidenceTextForTicket(m: EvidenceManifest, images: Record<string, string>, prUrl: string): string {
  const out = [`Evidence the feature works (gathered by Consort before handing the PR to reviewers)`, "", m.summary, "", `PR: ${prUrl}`, m.seeded ? `Local data: ${m.seeded}` : "", ""];
  m.items.forEach((it, n) => {
    out.push(`${n + 1}. ${it.title}${it.note ? ` — ${it.note}` : ""}`);
    if (it.command) out.push(`   $ ${it.command}`);
    if (it.image) out.push(`   ${images[it.image] ?? `(image ${it.image} not published)`}`);
    if (it.text) out.push(...it.text.split("\n").slice(0, 40).map((l) => `   ${l}`));
    out.push("");
  });
  out.push(`The same evidence, with the images inline, is on the PR.`);
  return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

/**
 * Every task gets an environment of its own so agents on one box never collide: a Docker
 * compose project name and label carrying the task's code, and a block of 100 ports from which
 * the app, database, cache and anything else take fixed offsets. The agent is told these on
 * every turn and keeps its overrides in .consort/env/ inside the worktree, never in tracked
 * files. When the task ends, everything labelled with the code is removed.
 */
export const PORT_FLOOR = 20_000;
export const PORT_BLOCK = 100;
export const PORT_CEILING = 60_000;
/** the first block at or above the floor that no live task holds */
export function allocatePortBase(used: number[], floor = PORT_FLOOR): number {
  const taken = new Set(used);
  for (let base = floor; base < PORT_CEILING; base += PORT_BLOCK) if (!taken.has(base)) return base;
  throw new Error("no free port block");
}
export const ENV_DIR = ".consort/env";
export const ENV_FILE = `${ENV_DIR}/.env.consort`;
export const ENV_DOC = ".consort/ship/ENV.md";
export type TaskEnv = Record<string, string>;
/** the variables every agent turn of the task runs with */
export function taskEnv(code: string, portBase: number): TaskEnv {
  const p = (n: number) => String(portBase + n);
  return {
    CONSORT_RUN: code, COMPOSE_PROJECT_NAME: code, CONSORT_DOCKER_RUN: code,
    CONSORT_PORT_BASE: String(portBase), CONSORT_PORT_RANGE: `${portBase}-${portBase + PORT_BLOCK - 1}`,
    PORT: p(0), CONSORT_APP_PORT: p(0), CONSORT_API_PORT: p(1), CONSORT_WEB_PORT: p(2), CONSORT_WORKER_PORT: p(3),
    CONSORT_DB_PORT: p(10), CONSORT_POSTGRES_PORT: p(10), CONSORT_REDIS_PORT: p(11), CONSORT_MONGO_PORT: p(12), CONSORT_MYSQL_PORT: p(13), CONSORT_ELASTIC_PORT: p(14), CONSORT_RABBIT_PORT: p(15), CONSORT_MAIL_PORT: p(16), CONSORT_S3_PORT: p(17),
    CONSORT_ENV_FILE: ENV_FILE, CONSORT_ENV_DIR: ENV_DIR,
  };
}

/** appended to every headless turn: the task's own ports and names, and the rules that keep tasks apart */
export const ENVIRONMENT_RULES = (env: TaskEnv) => `## Your environment on this machine (other agents share the box; these are yours alone)

- Docker: every container, network and volume you create must carry the label \`io.consort.run=${env.CONSORT_RUN}\` and a name starting \`${env.CONSORT_RUN}-\`. \`COMPOSE_PROJECT_NAME\` is already \`${env.CONSORT_RUN}\` in your shell, so \`docker compose\` isolates itself; never pass \`-p\` or a fixed \`container_name\` without the prefix. Consort removes everything with this label when the task ends.
- Ports: use only ${env.CONSORT_PORT_RANGE}. The app on ${env.CONSORT_APP_PORT} (\`PORT\` is set), a second service on ${env.CONSORT_API_PORT}, Postgres on ${env.CONSORT_DB_PORT}, Redis on ${env.CONSORT_REDIS_PORT}, Mongo on ${env.CONSORT_MONGO_PORT}, MySQL on ${env.CONSORT_MYSQL_PORT}, others from ${env.CONSORT_PORT_BASE}+20 up. Never the defaults (5432, 6379, 3000, 8080…): another task may be on them.
- Configuration: never edit the repo's tracked env or config files. Put your overrides in \`${env.CONSORT_ENV_FILE}\` (DATABASE_URL, REDIS_URL, PORT, hostnames…) and load it before running anything: \`set -a; . ${env.CONSORT_ENV_FILE}; set +a\`. If the repo has a compose file, add \`${env.CONSORT_ENV_DIR}/compose.override.yml\` that remaps its ports into your range and use \`docker compose -f <repo compose> -f ${env.CONSORT_ENV_DIR}/compose.override.yml\`.
- \`${env.CONSORT_ENV_DIR}/up.sh\` starts your services and the app, \`${env.CONSORT_ENV_DIR}/down.sh\` stops them. Use them in the test session and for evidence; leave nothing running when a turn ends unless the next step needs it.
- Secrets: only local, throwaway credentials in your overrides. Never copy production values.`;

/** the first turn of a task: find out what running this repo locally takes, and make it work on this task's ports */
export const ENVIRONMENT_PROMPT = (env: TaskEnv) => `## This turn: set up this task's local environment

Before any feature work, work out what it takes to run this repository locally and make it run on this task's own ports and containers, so the test session and the evidence step can start the app with seeded data at any time.

1. Read what the repo says about running it: README and docs, \`docker-compose*.yml\`, \`Dockerfile\`, \`.env.example\` or similar, \`package.json\` scripts (or the equivalent for its language), migrations and seed scripts, CI config. List every service it needs (database and kind, cache, queue, search, mail, object store), the env vars it reads, how migrations and seeds run, and how the dev server starts.
2. Write \`${ENV_DOC}\`: that list, then exactly how to start and stop everything for this task, with the real commands and this task's ports and names.
3. Write \`${env.CONSORT_ENV_FILE}\` with the overrides that point the app at your services on your ports (connection URLs, PORT, hosts), \`${env.CONSORT_ENV_DIR}/compose.override.yml\` if the repo uses compose, and \`${env.CONSORT_ENV_DIR}/up.sh\` / \`down.sh\` (bash, idempotent; up.sh starts services with the label and name prefix, waits until they answer, runs migrations and the seed when there is one, then starts the app in the background with its pid file under ${env.CONSORT_ENV_DIR}; down.sh stops the app and the services).
4. Prove it: run up.sh, check the database answers and the app responds on ${env.CONSORT_APP_PORT} (curl its root or health route), then run down.sh. Fix the scripts until both work.
5. Report in a few lines: the services, the ports, what seeds exist, and anything the repo needs that this machine lacks (name the missing tool; do not install system packages).

If the repository is a library or has no runnable app, say so in ENV.md and write up.sh/down.sh that only prepare what the tests need.`;

/** "3 files changed, 40 insertions(+), 2 deletions(-)" → { files, added, removed }; nothing changed → zeros */
export const parseShortstat = (text: string) => ({
  files: Number(/(\d+) files? changed/.exec(text)?.[1] ?? 0),
  added: Number(/(\d+) insertions?\(\+\)/.exec(text)?.[1] ?? 0),
  removed: Number(/(\d+) deletions?\(-\)/.exec(text)?.[1] ?? 0),
});
/** the DIFF cell: "+40 −2 ·3f", "+0 −0" while nothing has changed, "" when unknown */
export const diffCell = (d: { files: number; added: number; removed: number } | undefined) => (d ? `+${d.added} −${d.removed}${d.files ? ` ·${d.files}f` : ""}` : "");

/** the meters an account row shows: 5-hour, weekly, then one per model family, as short labels */
export type UsageBar = { short: string; label: string; percent: number; resetsAt?: number; tone: "ok" | "high" | "full" };
export function usageBars(windows: { id: string; label: string; percent: number; resetsAt?: number; model?: string; locked?: true }[]): UsageBar[] {
  const tone = (p: number, locked?: true): UsageBar["tone"] => (locked || p >= 95 ? "full" : p >= 80 ? "high" : "ok");
  const pick = (f: (w: (typeof windows)[number]) => boolean) => windows.find(f);
  const five = pick((w) => !w.model && /^5-hour/i.test(w.label));
  const week = pick((w) => !w.model && /^weekly$/i.test(w.label.trim()));
  const out: UsageBar[] = [];
  if (five) out.push({ short: "5h", label: five.label, percent: five.percent, resetsAt: five.resetsAt, tone: tone(five.percent) });
  if (week) out.push({ short: "wk", label: week.label, percent: week.percent, resetsAt: week.resetsAt, tone: tone(week.percent) });
  for (const w of windows.filter((w) => w.model)) out.push({ short: w.model!.toLowerCase().split(/\s+/)[0], label: w.label, percent: w.percent, resetsAt: w.resetsAt, tone: tone(w.percent, w.locked) });
  return out;
}
/** "5h ▰▰▰▱▱▱▱▱▱▱ 24" — one meter as text; `paint` colours by tone */
export const usageBarText = (b: UsageBar, width = 10, paint: (s: string, tone: UsageBar["tone"]) => string = (s) => s): string => {
  const filled = Math.round(Math.min(100, Math.max(0, b.percent)) / 100 * width);
  return `${b.short} ${paint("▰".repeat(filled) + "▱".repeat(width - filled), b.tone)} ${String(b.percent).padStart(3)}`;
};
