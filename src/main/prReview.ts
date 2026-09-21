/**
 * The `*.review.json` a PR review leaves behind, read and written from the main process, and
 * the one GitHub call that posts its approved comments. Everything that decides *what* to post
 * lives in shared/review.ts; this file only touches disk and `gh`.
 */
import { execFile } from "node:child_process";
import { promises as fs, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  applyVerdict, approvedFindings, commentableLines, draftBodyPrompt, driftBases, driftedFindings, fallbackReviewBody, parseReview, parseVerdict,
  patchesToDiff, recordSubmission, reviewPayload, serializeReview, updateFinding, verdictSummary, verifiedHead,
  type FindingStatus, type Review, type ReviewEvent, type VerdictReport,
  pickReviewFile, reviewSummary, recordFixRequest, type ReviewSummary,
} from "../shared/review";
import { store } from "./store";
import { defaultConnector } from "../shared/defaultConnector";
import { modelTiers } from "../shared/modelTiers";
import { askReadOnly } from "./sideChat";

const gh = (args: string[], cwd: string, input?: string) => new Promise<string>((resolve, reject) => {
  const child = execFile("gh", args, { cwd, timeout: 30_000, maxBuffer: 1 << 24 }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr || error.message).trim().split("\n").filter(Boolean).pop() || "gh failed"));
    else resolve(stdout);
  });
  if (input !== undefined) { child.stdin?.end(input); }
});

/** `owner/name`, from the file or from its PR URL */
export function repoOf(review: Review) {
  if (/^[\w.-]+\/[\w.-]+$/.test(review.repo)) return review.repo;
  const m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\//.exec(review.url);
  if (m) return m[1];
  throw new Error("The review file does not say which repository the PR belongs to.");
}

export async function readReview(path: string) {
  return { path, review: parseReview(await fs.readFile(path, "utf8")) };
}

/** note on the finding which chat is fixing it */
export async function setFixRequest(path: string, findingId: string, chatId: string) {
  const { review } = await readReview(path);
  const next = recordFixRequest(review, findingId, chatId, new Date().toISOString());
  await writeReview(path, next);
  return next;
}

/** the review file a branch owns, if any: relative path plus what it amounts to */
export async function findReview(worktreePath: string, pr?: number): Promise<{ path: string; summary: ReviewSummary } | null> {
  const dir = join(worktreePath, ".consort", "pr-review");
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const files = await Promise.all(names.map(async (name) => ({ name, mtime: (await fs.stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })));
  const name = pickReviewFile(files, pr);
  if (!name) return null;
  try {
    const review = parseReview(await fs.readFile(join(dir, name), "utf8"));
    return { path: join(".consort", "pr-review", name), summary: reviewSummary(review) };
  } catch {
    return null;
  }
}

async function writeReview(path: string, review: Review) {
  await fs.writeFile(path, serializeReview(review));
}

export async function setFinding(path: string, id: string, patch: { status?: FindingStatus; comment?: string }) {
  const { review } = await readReview(path);
  const next = updateFinding(review, id, patch);
  await writeReview(path, next);
  return next;
}

/** the PR as GitHub sees it now: head, open/merged/closed, its review decision, and the URL */
async function liveHead(review: Review, cwd: string) {
  const repo = repoOf(review);
  const j = JSON.parse(await gh(["pr", "view", String(review.pr), "--repo", repo, "--json", "headRefOid,state,reviewDecision,url"], cwd));
  return { head: (j.headRefOid as string) || null, state: (j.state as string) || null, reviewDecision: (j.reviewDecision as string) || "", url: (j.url as string) || review.url };
}

/** the files the PR changed between two commits, from GitHub's compare endpoint */
async function changedFiles(repo: string, from: string, to: string, cwd: string): Promise<Set<string>> {
  const compare = JSON.parse(await gh(["api", `repos/${repo}/compare/${from}...${to}?per_page=300`], cwd));
  return new Set<string>((compare.files ?? []).map((f: any) => String(f.filename)));
}

export type Drift = { head: string | null; state: string | null; reviewDecision: string; url: string; drifted: string[] };

/**
 * Where the PR's head is now, and which findings sit in a file that has changed since they
 * were last verified — each of those may be stale, fixed, or moved to another line.
 */
export async function reviewDrift(path: string): Promise<Drift> {
  const { review } = await readReview(path);
  const cwd = dirname(path);
  const live = await liveHead(review, cwd);
  if (!live.head) return { ...live, drifted: [] };
  const repo = repoOf(review);
  const bases = driftBases(review, live.head);
  const changedBy = new Map<string, Set<string>>();
  await Promise.all(bases.map(async (base) => changedBy.set(base, await changedFiles(repo, base, live.head!, cwd).catch(() => new Set<string>()))));
  return { ...live, drifted: [...driftedFindings(review, live.head, changedBy)] };
}

const REINVESTIGATE_SYSTEM = `You re-check one finding from an earlier code review against the pull request's newer commit. You only read. Decide whether the finding still holds exactly as written, still holds but needs a different comment or line, or no longer holds because the code changed. Be strict: "removed" only when the code at the new commit actually resolves or removes the concern, not because it moved. End your answer with a single JSON object on its own line: {"verdict":"same"|"modified"|"removed","line":<number at the new commit or null>,"comment":"<the comment to post, in the same voice, one sentence, opening with file:line>","reason":"<one plain sentence for the reviewer>"}.`;

const inFlight = new Set<string>();
export const investigating = (path: string, id: string) => inFlight.has(`${path}#${id}`);

/**
 * Re-run one finding against the PR's current head with a read-only agent: the file as it is
 * now, the diff since the finding was verified, and the finding itself. The verdict is written
 * back into the review file.
 */
export async function reinvestigate(path: string, id: string): Promise<{ review: Review; report: VerdictReport; summary: string; head: string }> {
  const flightKey = `${path}#${id}`;
  if (inFlight.has(flightKey)) throw new Error(`${id} is already being re-investigated.`);
  inFlight.add(flightKey);
  try {
    const { review } = await readReview(path);
    const finding = review.findings.find((f) => f.id === id);
    if (!finding) throw new Error(`No finding ${id} in this review.`);
    const cwd = dirname(path);
    const repo = repoOf(review);
    const live = await liveHead(review, cwd);
    if (!live.head) throw new Error("Could not read the PR's current head from GitHub.");
    const key = defaultConnector(store.data);
    if (!key) throw new Error("Add a connector in Settings to run a re-investigation.");
    const base = verifiedHead(review, finding);
    const [content, compare] = await Promise.all([
      gh(["api", `repos/${repo}/contents/${finding.file}?ref=${live.head}`, "--jq", ".content"], cwd)
        .then((b64) => Buffer.from(b64.replace(/\s/g, ""), "base64").toString("utf8"), () => null),
      base && base !== live.head
        ? gh(["api", `repos/${repo}/compare/${base}...${live.head}?per_page=300`], cwd).then((s) => JSON.parse(s), () => null)
        : Promise.resolve(null),
    ]);
    const filePatch = compare?.files?.find((f: any) => f.filename === finding.file)?.patch as string | undefined;
    const lines = content?.split("\n") ?? [];
    const at = finding.line ?? 1;
    const lo = Math.max(1, at - 120), hi = Math.min(lines.length, at + 120);
    const excerpt = content === null ? "(the file no longer exists at the new commit)"
      : lines.slice(lo - 1, hi).map((l, i) => `${String(lo + i).padStart(5)} | ${l}`).join("\n");
    const prompt = [
      `Repository ${repo}, PR #${review.pr} "${review.title}". The finding below was verified at commit ${base || "(unknown)"}; the PR head is now ${live.head}.`,
      `The worktree you are in may not be at the PR head — treat the excerpt and diff below as the truth for the new commit, and use Read/Grep only for surrounding context (callers, peers, tests).`,
      ``,
      `## Finding ${finding.id}`,
      JSON.stringify({ kind: finding.kind, severity: finding.severity, category: finding.category, title: finding.title, file: finding.file, line: finding.line, problem: finding.problem, exampleFlow: finding.exampleFlow, fix: finding.fix, ignoreIf: finding.ignoreIf, fields: finding.fields, comment: finding.comment }, null, 2),
      ``,
      `## ${finding.file} at ${live.head} (lines ${lo}–${hi} of ${lines.length})`,
      "```", excerpt, "```",
      ``,
      `## Changes to ${finding.file} between ${base || "the reviewed commit"} and ${live.head}`,
      filePatch ? "```diff\n" + filePatch + "\n```" : compare === null ? "(no diff available)" : "(this file did not change)",
      ``,
      `Decide same / modified / removed and end with the JSON object.`,
    ].join("\n");
    const model = modelTiers(key.provider, store.public().models?.[key.provider]).delegate;
    const text = await askReadOnly(cwd, prompt, key, { model, system: REINVESTIGATE_SYSTEM, maxTurns: 16 });
    const report = parseVerdict(text);
    const next = applyVerdict((await readReview(path)).review, id, report, live.head, new Date().toISOString());
    await writeReview(path, next);
    return { review: next, report, summary: verdictSummary(finding, report), head: live.head };
  } finally {
    inFlight.delete(flightKey);
  }
}

export type SubmitOptions = { event: ReviewEvent; body: string; inline: boolean; draft: boolean };
export type SubmitResult = { url: string; event: ReviewEvent; body: string; drafted: boolean; inline: string[]; general: string[]; headMoved: boolean };

const DRAFT_SYSTEM = "You write the top-level body of a pull-request review in the reviewer's own voice. Reply with only the body text: no preamble, no quotes, no markdown headings.";

/**
 * Submit one GitHub review: the verdict, a body (Mitch's, or drafted by the model when left
 * blank), and — when asked — every queued comment inline, pinned to the commit the review read.
 * Lines the diff at that commit does not show fall into the body, so a comment is never lost.
 */
export async function submitReview(path: string, opts: SubmitOptions): Promise<{ review: Review; result: SubmitResult }> {
  const { review } = await readReview(path);
  const findings = opts.inline ? approvedFindings(review) : [];
  if (opts.inline && !findings.length && !opts.body.trim() && !opts.draft && opts.event === "COMMENT") throw new Error("Nothing is approved. Use “Comment on PR” on the findings you want to post.");
  if (!review.head) throw new Error("The review file has no head SHA to pin the review to.");
  const repo = repoOf(review);
  const cwd = dirname(path);
  const [compare, live] = await Promise.all([
    findings.length ? gh(["api", `repos/${repo}/compare/${review.base}...${review.head}?per_page=300`], cwd).then((s) => JSON.parse(s)) : Promise.resolve({ files: [] }),
    liveHead(review, cwd).catch(() => null),
  ]);
  const commentable = commentableLines(patchesToDiff(compare.files ?? []));
  let body = opts.body.trim(), drafted = false;
  if (!body && opts.draft) {
    const key = defaultConnector(store.data);
    if (key) {
      const model = modelTiers(key.provider, store.public().models?.[key.provider]).delegate;
      body = await askReadOnly(cwd, draftBodyPrompt(review, opts.event, findings), key, { model, system: DRAFT_SYSTEM, maxTurns: 2 }).then((t) => t.trim(), () => "");
      drafted = !!body;
    }
    if (!body) body = fallbackReviewBody(review, opts.event, findings);
  }
  const built = reviewPayload(review, findings, commentable, { event: opts.event, body });
  if (!built) throw new Error("There is nothing to submit: no body and no approved comments.");
  const response = JSON.parse(await gh(["api", "-X", "POST", `repos/${repo}/pulls/${review.pr}/reviews`, "--input", "-"], cwd, JSON.stringify(built.payload)));
  const url = String(response.html_url ?? review.url);
  const next = recordSubmission(review, {
    at: new Date().toISOString(), event: opts.event, url, body, inline: findings.map((f) => f.id),
    ...(typeof response.id === "number" ? { reviewId: response.id } : {}), ...(drafted ? { drafted: true } : {}),
  });
  await writeReview(path, next);
  return { review: next, result: { url, event: opts.event, body, drafted, inline: built.inline.map((f) => f.id), general: built.general.map((f) => f.id), headMoved: !!live?.head && live.head !== review.head } };
}

/** Watch a review file (through its directory, so atomic saves are seen) and call back on change. */
export class ReviewWatchers {
  private watchers = new Map<string, { watcher: FSWatcher; refs: number; timer?: NodeJS.Timeout }>();
  constructor(private onChange: (path: string) => void) {}
  add(path: string) {
    const existing = this.watchers.get(path);
    if (existing) { existing.refs++; return; }
    const name = basename(path);
    const entry = { refs: 1, timer: undefined as NodeJS.Timeout | undefined, watcher: watch(dirname(path), (_event, changed) => {
      if (changed && changed.toString() !== name) return;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.onChange(path), 150);
    }) };
    entry.watcher.on("error", () => this.drop(path));
    this.watchers.set(path, entry);
  }
  remove(path: string) {
    const entry = this.watchers.get(path);
    if (!entry) return;
    if (--entry.refs <= 0) this.drop(path);
  }
  private drop(path: string) {
    const entry = this.watchers.get(path);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.watcher.close();
    this.watchers.delete(path);
  }
}
