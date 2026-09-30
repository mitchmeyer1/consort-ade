/**
 * A PR review as data. The pr-writeup skill writes one `*.review.json` per PR; Consort renders
 * it, lets Mitch approve or ignore each finding, and posts the approved ones to GitHub as a
 * single review. The file is the source of truth for both the document and what was posted.
 */

import { parseDeployProfile, type DeployProfile } from "./deployProfile.ts";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const CATEGORIES = ["logic", "redundant", "style", "tests", "comments", "scaling"] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABELS: Record<Category, string> = { logic: "Logic", redundant: "Redundant", style: "Style", tests: "Tests", comments: "Comments", scaling: "Scaling" };
export const SEVERITY_LABELS: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

/** pending: not decided · approved: queued for the next post · commented: on GitHub · ignored: Mitch passed · dropped: a re-investigation found it no longer holds */
/** fixing: handed to a chat in the worktree by "Fix locally"; a decision like ignore, undone by hand */
export const FINDING_STATUSES = ["pending", "approved", "commented", "ignored", "dropped", "fixing"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export type Finding = {
  /** stable within the file: D1… for defects, L1/R1/S1/T1/C1… for category items */
  id: string;
  kind: "defect" | "item";
  severity?: Severity;
  category?: Category;
  /** the heading: consequence for a defect, the claim for an item */
  title: string;
  /** repo-relative path and line at the review head; absent only for a deliberately general PR comment */
  file?: string;
  line?: number;
  /** defect fields, plain first, refs second */
  problem?: string;
  exampleFlow?: string;
  fix?: string;
  ignoreIf?: string;
  /** category-card fields in the order the card shows them (Gap/Fix, Overlap/Do, House way/Fix, Costs/Suite/Test, Trimmed) */
  fields?: Record<string, string>;
  /** the ready-to-post GitHub comment in Mitch's voice; every retained finding has one */
  comment?: string;
  status: FindingStatus;
  /** set when the comment landed on GitHub */
  posted?: { url: string; at: string; reviewId?: number };
  /** the PR commit this finding was last checked against; unset means the review's head */
  head?: string;
  /** the last re-investigation against a newer PR head */
  investigation?: Investigation;
  /** set when "Fix locally" handed this finding to a chat in the worktree */
  fixRequest?: FixRequest;
};
export type FixRequest = { chatId: string; at: string };

export const VERDICTS = ["same", "modified", "removed"] as const;
export type Verdict = (typeof VERDICTS)[number];
export type Investigation = { at: string; head: string; verdict: Verdict; reason: string; previousComment?: string };

export type Flow = {
  name: string;
  trigger: string;
  /** hops in order, each `text` with an optional `ref` (file:line) */
  hops: { text: string; ref?: string }[];
  endsIn: string;
  reachable: boolean;
  gate?: string;
  mode: "human" | "unattended";
};

export type Review = {
  version: 1;
  repo: string;
  pr: number;
  url: string;
  title: string;
  subtitle?: string;
  head: string;
  base: string;
  state?: string;
  stats?: { files: number; additions: number; deletions: number };
  reviewedAt: string;
  /** What it does / What ships today / Headline, each plain prose */
  whatItDoes?: string;
  shipsToday?: string;
  headline?: string;
  pattern?: string;
  flows: Flow[];
  findings: Finding[];
  /** one sentence on the PR's test files and what they prove */
  testsExisting?: string;
  appendix: string[];
  wellBuilt: { what: string; why: string; ref?: string }[];
  orderOfWork: { step: string; why: string; refs?: string[] }[];
  ci?: { status: string; url?: string };
  /** what the project runs on and the ceilings every Scaling finding is measured against */
  deploy?: DeployProfile;
  method?: string;
  /** the GitHub reviews submitted from this file, newest last */
  submissions: Submission[];
};

export const REVIEW_EVENTS = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];
export const EVENT_LABELS: Record<ReviewEvent, string> = { COMMENT: "Comment", APPROVE: "Approve", REQUEST_CHANGES: "Request changes" };
export type Submission = { at: string; event: ReviewEvent; url: string; body: string; inline: string[]; reviewId?: number; drafted?: boolean };

export const isReviewFile = (path: string) => /\.review\.json$/i.test(path.split("#")[0].replace(/:\d+(?::\d+)?$/, ""));

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
const list = <T,>(v: unknown, map: (x: any, index: number) => T | undefined): T[] => (Array.isArray(v) ? v.map(map).filter((x): x is T => x !== undefined) : []);

function finding(raw: any, index: number): Finding | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const severity = SEVERITIES.includes(raw.severity) ? (raw.severity as Severity) : undefined;
  const category = CATEGORIES.includes(raw.category) ? (raw.category as Category) : undefined;
  const kind: Finding["kind"] = raw.kind === "item" || (raw.kind !== "defect" && !severity) ? "item" : "defect";
  const title = str(raw.title ?? raw.claim);
  const file = str(raw.file ?? raw.path);
  if (!title) return undefined;
  const fields = raw.fields && typeof raw.fields === "object"
    ? Object.fromEntries(Object.entries(raw.fields).filter(([, v]) => typeof v === "string") as [string, string][])
    : undefined;
  const status = FINDING_STATUSES.includes(raw.status) ? (raw.status as FindingStatus) : "pending";
  const posted = raw.posted && typeof raw.posted.url === "string" ? { url: raw.posted.url, at: str(raw.posted.at), reviewId: num(raw.posted.reviewId) } : undefined;
  const inv = raw.investigation;
  const investigation: Investigation | undefined = inv && VERDICTS.includes(inv.verdict) && typeof inv.head === "string"
    ? { at: str(inv.at), head: inv.head, verdict: inv.verdict, reason: str(inv.reason), ...(str(inv.previousComment) ? { previousComment: inv.previousComment } : {}) } : undefined;
  const fixRequest: FixRequest | undefined = raw.fixRequest && typeof raw.fixRequest.chatId === "string" ? { chatId: raw.fixRequest.chatId, at: str(raw.fixRequest.at) } : undefined;
  return {
    id: str(raw.id) || `${kind === "defect" ? "D" : "I"}${index + 1}`,
    kind, severity: kind === "defect" ? severity ?? "low" : undefined, category,
    title, file: file || undefined, line: file ? num(raw.line) : undefined,
    problem: str(raw.problem) || undefined, exampleFlow: str(raw.exampleFlow ?? raw.example) || undefined,
    fix: str(raw.fix) || undefined, ignoreIf: str(raw.ignoreIf) || undefined,
    fields: fields && Object.keys(fields).length ? fields : undefined,
    comment: str(raw.comment ?? raw.prComment) || undefined,
    status: status === "commented" && !posted ? "approved" : status,
    posted,
    head: str(raw.head) || undefined,
    investigation,
    fixRequest,
  };
}

function flow(raw: any): Flow | undefined {
  if (!raw || typeof raw !== "object" || !str(raw.name)) return undefined;
  return {
    name: raw.name, trigger: str(raw.trigger), endsIn: str(raw.endsIn ?? raw.ends_in),
    hops: list(raw.hops, (h) => typeof h === "string" ? { text: h } : h && typeof h.text === "string" ? { text: h.text, ref: str(h.ref) || undefined } : undefined),
    reachable: raw.reachable !== false, gate: str(raw.gate) || undefined,
    mode: raw.mode === "unattended" ? "unattended" : "human",
  };
}

/** Read a review file leniently: fill defaults, drop malformed entries, fail only on what cannot be shown. */
export function parseReview(text: string): Review {
  let raw: any;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`Not valid JSON: ${(e as Error).message}`); }
  if (!raw || typeof raw !== "object") throw new Error("A review file must be a JSON object.");
  const pr = num(raw.pr ?? raw.number);
  if (!pr) throw new Error("A review file needs a `pr` number.");
  if (!Array.isArray(raw.findings)) throw new Error("A review file needs a `findings` array.");
  const ids = new Set<string>();
  const findings = list(raw.findings, finding).map((f) => {
    let id = f.id, n = 2;
    while (ids.has(id)) id = `${f.id}-${n++}`;
    ids.add(id);
    return { ...f, id };
  });
  return {
    version: 1,
    repo: str(raw.repo), pr, url: str(raw.url), title: str(raw.title, `PR ${pr}`), subtitle: str(raw.subtitle) || undefined,
    head: str(raw.head ?? raw.headSha), base: str(raw.base ?? raw.baseSha), state: str(raw.state) || undefined,
    stats: raw.stats && typeof raw.stats === "object" ? { files: num(raw.stats.files) ?? 0, additions: num(raw.stats.additions) ?? 0, deletions: num(raw.stats.deletions) ?? 0 } : undefined,
    reviewedAt: str(raw.reviewedAt),
    whatItDoes: str(raw.whatItDoes) || undefined, shipsToday: str(raw.shipsToday) || undefined, headline: str(raw.headline) || undefined, pattern: str(raw.pattern) || undefined,
    flows: list(raw.flows, flow),
    findings,
    testsExisting: str(raw.testsExisting) || undefined,
    appendix: list(raw.appendix, (a) => (typeof a === "string" ? a : undefined)),
    wellBuilt: list(raw.wellBuilt, (g) => (g && typeof g.what === "string" ? { what: g.what, why: str(g.why), ref: str(g.ref) || undefined } : undefined)),
    orderOfWork: list(raw.orderOfWork, (o) => typeof o === "string" ? { step: o, why: "" } : o && typeof o.step === "string" ? { step: o.step, why: str(o.why), refs: list(o.refs, (r) => (typeof r === "string" ? r : undefined)) } : undefined),
    ci: raw.ci && typeof raw.ci === "object" ? { status: str(raw.ci.status), url: str(raw.ci.url) || undefined } : undefined,
    deploy: parseDeployProfile(raw.deploy),
    method: str(raw.method) || undefined,
    submissions: list(raw.submissions, (x) => x && REVIEW_EVENTS.includes(x.event) && typeof x.url === "string"
      ? { at: str(x.at), event: x.event as ReviewEvent, url: x.url, body: str(x.body), inline: list(x.inline, (i) => (typeof i === "string" ? i : undefined)), ...(num(x.reviewId) !== undefined ? { reviewId: num(x.reviewId) } : {}), ...(x.drafted ? { drafted: true } : {}) }
      : undefined),
  };
}

export const serializeReview = (review: Review) => JSON.stringify(review, null, 2) + "\n";

/** Change what Mitch decided about one finding; a posted comment cannot be un-posted from here. */
export function updateFinding(review: Review, id: string, patch: { status?: FindingStatus; comment?: string }): Review {
  const target = review.findings.find((f) => f.id === id);
  if (!target) throw new Error(`No finding ${id} in this review.`);
  if (target.status === "commented" && patch.status && patch.status !== "commented") throw new Error("That comment is already on GitHub.");
  if (patch.status === "commented") throw new Error("Post to GitHub to mark a finding as commented.");
  if (patch.status === "dropped") throw new Error("Only a re-investigation drops a finding; use Ignore to pass on it.");
  if (patch.status === "fixing") throw new Error("Use Fix locally to hand a finding to the chat.");
  return { ...review, findings: review.findings.map((f) => f.id !== id ? f : { ...f, ...(patch.status ? { status: patch.status } : {}), ...(patch.comment !== undefined ? { comment: patch.comment } : {}) }) };
}

/** the message "Fix locally" sends: the finding as the reviewer wrote it, the user's own direction when they added any, then how to go about the change */
export function fixPrompt(review: Review, f: Finding, note?: string) {
  const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "General PR comment";
  const lines = [`Fix ${f.id} from the PR ${review.pr} review (${review.title}) locally, in this worktree.`, "", `**${f.title}**`, `File: ${where}`];
  if (f.kind === "defect") {
    for (const [label, text] of [["Problem", f.problem], ["Example flow", f.exampleFlow], ["Suggested fix", f.fix]] as const) if (text) lines.push(`${label}: ${text}`);
  } else {
    for (const [label, text] of Object.entries(f.fields ?? {})) if (text) lines.push(`${label}: ${text}`);
  }
  // the user's direction outranks the reviewer's suggestion when the two disagree
  if (note?.trim()) lines.push("", "Direction from Mitch, which takes precedence over the suggested fix where they differ:", note.trim());
  lines.push("", "Make the smallest change that resolves it, in the style of the surrounding code, and run the tests that cover it. Do not commit, and do not edit the review file. Finish with a short paragraph on what changed and where.");
  return lines.join("\n");
}

/**
 * Remember which chat took the finding, so the card can link back to it. Handing it off is a
 * decision: an undecided or ignored finding becomes "fixing"; one already queued or posted keeps
 * that standing, since the comment still belongs on the PR.
 */
export function recordFixRequest(review: Review, id: string, chatId: string, at: string): Review {
  if (!review.findings.some((f) => f.id === id)) throw new Error(`No finding ${id} in this review.`);
  const decide = (status: FindingStatus): FindingStatus => (status === "pending" || status === "ignored" ? "fixing" : status);
  return { ...review, findings: review.findings.map((f) => (f.id === id ? { ...f, status: decide(f.status), fixRequest: { chatId, at } } : f)) };
}

export const approvedFindings = (review: Review) => review.findings.filter((f) => f.status === "approved" && f.comment?.trim());

/** the undecided findings "Comment all" would queue: those with a prepared comment to post */
export const queueableFindings = (review: Review) => review.findings.filter((f) => f.status === "pending" && f.comment?.trim());

/**
 * "Comment all": trust the review and queue every undecided finding that has a comment. Ignored,
 * fixing, posted and dropped findings are decisions already made and stay as they are.
 */
export function queueAll(review: Review): Review {
  const ids = new Set(queueableFindings(review).map((f) => f.id));
  return ids.size ? { ...review, findings: review.findings.map((f) => (ids.has(f.id) ? { ...f, status: "approved" as FindingStatus } : f)) } : review;
}

/** Defects by severity, then items by category, in the order the document shows them. */
export function groupFindings(findings: Finding[]) {
  const defects = SEVERITIES.map((severity) => ({ key: severity, label: SEVERITY_LABELS[severity], findings: findings.filter((f) => f.kind === "defect" && f.severity === severity) }));
  const items = CATEGORIES.map((category) => ({ key: category, label: CATEGORY_LABELS[category], findings: findings.filter((f) => f.kind === "item" && f.category === category) }));
  const other = findings.filter((f) => f.kind === "item" && !f.category);
  return { defects, items: other.length ? [...items, { key: "other", label: "Other", findings: other }] : items };
}

export function reviewCounts(review: Review) {
  const by = (pick: (f: Finding) => boolean) => review.findings.filter(pick).length;
  return {
    defects: by((f) => f.kind === "defect"), items: by((f) => f.kind === "item"),
    pending: by((f) => f.status === "pending"), approved: by((f) => f.status === "approved"),
    commented: by((f) => f.status === "commented"), ignored: by((f) => f.status === "ignored"), dropped: by((f) => f.status === "dropped"), fixing: by((f) => f.status === "fixing"),
    severity: Object.fromEntries(SEVERITIES.map((s) => [s, by((f) => f.kind === "defect" && f.severity === s)])) as Record<Severity, number>,
    category: Object.fromEntries(CATEGORIES.map((c) => [c, by((f) => f.kind === "item" && f.category === c)])) as Record<Category, number>,
  };
}

/**
 * The lines GitHub will accept an inline comment on: every line of the new file that a hunk
 * touches or shows as context. Takes a unified diff (`git diff`, `gh pr diff`) and returns
 * them per path.
 */
export function commentableLines(unifiedDiff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: string | undefined, line = 0, remaining = 0;
  for (const raw of unifiedDiff.split("\n")) {
    if (raw.startsWith("diff --git ")) { file = undefined; remaining = 0; continue; }
    if (raw.startsWith("+++ ")) { const p = raw.slice(4).trim(); file = p === "/dev/null" ? undefined : p.replace(/^b\//, ""); remaining = 0; continue; }
    if (raw.startsWith("--- ") && !remaining) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk) { line = Number(hunk[1]); remaining = hunk[2] === undefined ? 1 : Number(hunk[2]); if (file && !out.has(file)) out.set(file, new Set()); continue; }
    if (!remaining || !file) continue;
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("-")) continue;
    // an added or context line on the new side; a blank context line may have lost its leading space
    out.get(file)!.add(line); line++; remaining--;
  }
  return out;
}

/** The compare API returns one patch per file with no headers; give it the headers the parser wants. */
export const patchesToDiff = (files: { filename: string; patch?: string }[]) =>
  files.filter((f) => f.patch).map((f) => `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}\n`).join("");

export type ReviewPayload = {
  commit_id: string;
  event: ReviewEvent;
  body: string;
  comments: { path: string; line: number; side: "RIGHT"; body: string }[];
};

/**
 * One GitHub review: the verdict, a body, and every included comment — inline where the line
 * is part of the diff, otherwise listed under the body with its `file:line`, so nothing is
 * dropped and the author gets one notification. Returns null when there is nothing to send.
 */
export function reviewPayload(review: Review, findings: Finding[], commentable: Map<string, Set<number>>, opts: { event?: ReviewEvent; body?: string } = {}): { payload: ReviewPayload; inline: Finding[]; general: Finding[] } | null {
  const inline: Finding[] = [], general: Finding[] = [];
  for (const f of findings) {
    if (!f.comment?.trim()) continue;
    (f.file && f.line && commentable.get(f.file)?.has(f.line) ? inline : general).push(f);
  }
  const event = opts.event ?? "COMMENT";
  const lead = (opts.body ?? "").trim();
  if (!inline.length && !general.length && !lead && event === "COMMENT") return null;
  const listed = general.map((f) => f.file ? `**${f.file}${f.line ? `:${f.line}` : ""}** — ${f.comment!.trim()}` : f.comment!.trim()).join("\n\n");
  const body = [lead, listed].filter(Boolean).join("\n\n");
  return {
    payload: {
      commit_id: review.head, event, body,
      // Only findings with a file and line enter `inline` above; retain that invariant here.
      comments: inline.map((f) => ({ path: f.file!, line: f.line!, side: "RIGHT", body: f.comment!.trim() })),
    },
    inline, general,
  };
}

/** every finding has been decided one way or another */
export const allDecided = (review: Review) => review.findings.length > 0 && review.findings.every((f) => f.status !== "pending");

/** the verdict the findings point at: open high-severity defects ask for changes, any comment is a comment, nothing left is an approval */
export function suggestedEvent(review: Review): ReviewEvent {
  const live = review.findings.filter((f) => f.status === "approved" || f.status === "commented");
  if (live.some((f) => f.kind === "defect" && (f.severity === "critical" || f.severity === "high"))) return "REQUEST_CHANGES";
  if (live.length || review.findings.some((f) => f.status === "pending")) return "COMMENT";
  return "APPROVE";
}

/** the review body when no one, human or model, wrote one */
export function fallbackReviewBody(review: Review, event: ReviewEvent, included: Finding[]): string {
  const counts = reviewCounts(review);
  const defects = included.filter((f) => f.kind === "defect").length;
  const items = included.length - defects;
  const parts: string[] = [];
  if (review.headline) parts.push(review.headline);
  if (included.length) parts.push(`Left ${included.length} comment${included.length === 1 ? "" : "s"}${defects ? ` (${defects} defect${defects === 1 ? "" : "s"}${items ? `, ${items} smaller item${items === 1 ? "" : "s"}` : ""})` : ""}.`);
  else if (counts.commented) parts.push("My comments are already on the PR.");
  if (event === "APPROVE") parts.push("Looks good to merge.");
  else if (event === "REQUEST_CHANGES") parts.push("Requesting changes for the defects called out inline.");
  return parts.join(" ").trim() || `Reviewed at ${review.head.slice(0, 7)}.`;
}

/** what the model gets when the body is left blank */
export function draftBodyPrompt(review: Review, event: ReviewEvent, included: Finding[]): string {
  const earlier = review.findings.filter((f) => f.status === "commented" && !included.includes(f));
  const line = (f: Finding) => `- ${f.id} · ${f.kind === "defect" ? f.severity : f.category} · ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "general PR comment"} — ${f.title}${f.comment ? `\n  comment: ${f.comment}` : ""}`;
  return [
    `Write the top-level body of a GitHub pull-request review for PR #${review.pr} "${review.title}"${review.repo ? ` in ${review.repo}` : ""}. The verdict is ${EVENT_LABELS[event]}.`,
    `Voice: the reviewer's own, first person, plain and direct, two to five sentences, no headings, no bullet lists, no emoji, no sign-off, no restating each inline comment. Say what the PR does well in one clause, what the comments add up to, and what the verdict means for the author. Do not invent findings.`,
    review.headline ? `\nReviewer's headline: ${review.headline}` : "",
    review.whatItDoes ? `What the PR does: ${review.whatItDoes}` : "",
    review.wellBuilt.length ? `Well built: ${review.wellBuilt.map((g) => g.what).join("; ")}` : "",
    included.length ? `\nComments going inline with this review:\n${included.map(line).join("\n")}` : "\nNo inline comments go with this review.",
    earlier.length ? `\nComments already on the PR from an earlier post:\n${earlier.map(line).join("\n")}` : "",
    review.orderOfWork.length ? `\nSuggested order of work: ${review.orderOfWork.map((o) => o.step).join("; ")}` : "",
    `\nReply with only the body text.`,
  ].filter(Boolean).join("\n");
}

/** Record a submitted review and mark the comments it carried as posted. */
export function recordSubmission(review: Review, submission: Submission): Review {
  const posted = { url: submission.url, at: submission.at, ...(submission.reviewId !== undefined ? { reviewId: submission.reviewId } : {}) };
  const withPosted = submission.inline.length ? markPosted(review, submission.inline, posted) : review;
  return { ...withPosted, submissions: [...withPosted.submissions, submission] };
}

/** Record that a review landed, on the findings it carried. */
export function markPosted(review: Review, ids: string[], posted: { url: string; at: string; reviewId?: number }): Review {
  const set = new Set(ids);
  return { ...review, findings: review.findings.map((f) => (set.has(f.id) ? { ...f, status: "commented", posted } : f)) };
}

/** A short line for the file's place in a chat, sidebar or tab. */
export const reviewLabel = (review: Review) => `PR ${review.pr}${review.title ? ` · ${review.title}` : ""}`;

/** the commit a finding was last verified against */
export const verifiedHead = (review: Review, f: Finding) => f.head || review.head;

/**
 * Which findings sit in a file the PR has changed since they were last verified. `changedBy`
 * maps a verified commit to the files changed between it and the live head.
 */
export function driftedFindings(review: Review, liveHead: string, changedBy: Map<string, Set<string>>): Set<string> {
  const out = new Set<string>();
  for (const f of review.findings) {
    const base = verifiedHead(review, f);
    if (!base || base === liveHead) continue;
    if (f.file && changedBy.get(base)?.has(f.file)) out.add(f.id);
  }
  return out;
}

/** the distinct commits a drift check has to compare against the live head */
export const driftBases = (review: Review, liveHead: string) =>
  [...new Set(review.findings.map((f) => verifiedHead(review, f)))].filter((h) => h && h !== liveHead);

export type VerdictReport = { verdict: Verdict; reason: string; comment?: string; line?: number };

/** The agent's answer ends in a JSON object; take the last one and keep only what we can use. */
export function parseVerdict(text: string): VerdictReport {
  const candidates = text.match(/\{[^{}]*"verdict"[^{}]*\}/g);
  if (!candidates) throw new Error("The re-investigation gave no verdict.");
  let raw: any;
  try { raw = JSON.parse(candidates[candidates.length - 1]); } catch { throw new Error("The re-investigation's verdict was not valid JSON."); }
  const verdict = String(raw.verdict ?? "").toLowerCase();
  if (!VERDICTS.includes(verdict as Verdict)) throw new Error(`The re-investigation gave an unknown verdict: ${raw.verdict}`);
  return {
    verdict: verdict as Verdict,
    reason: str(raw.reason),
    comment: str(raw.comment) || undefined,
    line: num(raw.line),
  };
}

/**
 * Record a re-investigation. Undecided or queued findings take the new comment and line, or
 * are dropped; a comment already on GitHub only gets the verdict noted beside it.
 */
export function applyVerdict(review: Review, id: string, report: VerdictReport, head: string, at: string): Review {
  const target = review.findings.find((f) => f.id === id);
  if (!target) throw new Error(`No finding ${id} in this review.`);
  const investigation: Investigation = { at, head, verdict: report.verdict, reason: report.reason, ...(report.verdict === "modified" && target.comment ? { previousComment: target.comment } : {}) };
  const settled = target.status === "commented" || target.status === "ignored";
  const next: Finding = { ...target, head, investigation };
  if (!settled) {
    if (report.verdict === "removed") next.status = "dropped";
    else if (report.verdict === "modified") {
      if (report.comment) next.comment = report.comment;
      if (report.line) next.line = report.line;
      if (target.status === "dropped") next.status = "pending";
    } else if (target.status === "dropped") next.status = "pending";
  }
  return { ...review, findings: review.findings.map((f) => (f.id === id ? next : f)) };
}

/** what the toast says once a re-investigation is back */
export function verdictSummary(f: Finding, report: VerdictReport) {
  const posted = f.status === "commented";
  if (report.verdict === "same") return `${f.id} still holds — comment unchanged`;
  if (report.verdict === "modified") return posted ? `${f.id} changed on the PR — the posted comment may need a follow-up` : `${f.id} still holds — comment updated`;
  return posted ? `${f.id} looks fixed on the PR — the posted comment is now stale` : `${f.id} no longer holds — dropped`;
}

/** what a finished review amounts to, for the chat footer and the top bar */
export type ReviewSummary = { pr: number; title: string; url: string; reviewedAt: string; total: number; pending: number; queued: number; commented: number; ignored: number; fixing: number; submitted: number };
export function reviewSummary(review: Review): ReviewSummary {
  const count = (status: FindingStatus) => review.findings.filter((f) => f.status === status).length;
  return {
    pr: review.pr, title: review.title, url: review.url, reviewedAt: review.reviewedAt,
    total: review.findings.length, pending: count("pending"), queued: count("approved"), commented: count("commented"), ignored: count("ignored") + count("dropped"), fixing: count("fixing"),
    submitted: review.submissions?.length ?? 0,
  };
}

/** the review file a chat or branch owns: the PR's own file when we know the number, else the newest */
export function pickReviewFile(files: { name: string; mtime: number }[], pr?: number) {
  const reviews = files.filter((f) => isReviewFile(f.name));
  if (pr !== undefined) { const own = reviews.find((f) => f.name === `pr-${pr}.review.json`); if (own) return own.name; }
  return reviews.sort((a, b) => b.mtime - a.mtime)[0]?.name;
}

/** the PR number a review chat is named for, as prChatName writes it */
export const prNumberOf = (name: string) => { const m = /PR #(\d+)/.exec(name); return m ? Number(m[1]) : undefined; };

/**
 * Read something another process may be writing this instant. A review file is rewritten whole
 * by the agent and by every decision made in the view, and a read that lands mid-write parses as
 * garbage. Retry a few times, briefly, before believing the failure.
 */
export async function settle<T>(read: () => Promise<T>, tries = 4, delayMs = 120): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await read(); } catch (e) { last = e; }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw last;
}
