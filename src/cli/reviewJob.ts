/**
 * Automatic PR review. A review scanner (`--source review --reviewer <login>`) watches the
 * repository's open PRs that are assigned to that login or ask it for a review; each PR head gets
 * one review task. The worker for a review task:
 *
 *  1. checks the PR head out in its own worktree, copies the repo root's .env files in, and sets up
 *     the databases and services the repo needs (the same environment turn build tasks run);
 *  2. has the frontier model (Fable or Astra) read the repo, its conventions, .ai-review-rules.md
 *     and the diff, and split the review into areas (.consort/review/OVERVIEW.md, plan.json);
 *  3. fans out one read-only reviewer per area on Opus or Sol, each crawling its files, their
 *     callers and similar code for correctness, scaling and convention problems;
 *  4. has the frontier model verify every finding against the code, merge duplicates and settle
 *     severities, written as a standard .review.json the desktop app can open;
 *  5. posts one GitHub review: REQUEST_CHANGES when anything is Critical or High, otherwise the
 *     comments, then asks the owner on Slack with a short TL;DR before it approves.
 */
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { addTurnCost, ENVIRONMENT_RULES, HEADLESS_RULES, seedModels, slackMessage, slackStatus } from "../shared/headless.ts";
import { selectCliModel } from "../shared/cliModels.ts";
import { modelBlock, modelLoad, usageBlock } from "../shared/usage.ts";
import { parseReview, serializeReview, type Finding, type Review, type ReviewEvent } from "../shared/review.ts";
import { newShipFeature } from "../shared/ship.ts";
import type { Provider } from "../shared/types.ts";
import { runTurn } from "./agent";
import { withAgentTurn } from "./capacity";
import { allocateEnvironment, cleanupEnvironment } from "./environment";
import { oversightModel } from "./oversight";
import { postReview } from "./reviewPost";
import { environmentPrompt, saveRepoEnv } from "./repoEnv";
import { Slack } from "./slack";
import { blockAccount, HOME, loadState, newId, touchAccount, updateTask, WORK_DIR, type Account, type Job, type Task } from "./state";
import { usageFor } from "./usage";

const run = promisify(execFile);
const sh = async (cmd: string, args: string[], cwd: string) => (await run(cmd, args, { cwd, timeout: 300_000, maxBuffer: 64 << 20 })).stdout;

export type ReviewTarget = { repo: string; pr: number; url: string; title: string; author: string; head: string; base: string };
export type OpenPr = { number: number; title: string; url: string; headRefOid: string; baseRefName: string; isDraft: boolean; author?: { login?: string }; assignees?: { login?: string }[]; reviewRequests?: { login?: string }[] };

// ── scanning ───────────────────────────────────────────────────────────────────────────────

/** PRs that want a review from `reviewer` and have no review task at their current head yet */
export function reviewCandidates(prs: OpenPr[], reviewer: string, tasks: Task[]): OpenPr[] {
  const me = reviewer.toLowerCase();
  return prs.filter((p) => !p.isDraft
    && (p.assignees ?? []).concat(p.reviewRequests ?? []).some((u) => u.login?.toLowerCase() === me)
    && (p.author?.login ?? "").toLowerCase() !== me
    && !tasks.some((t) => t.kind === "review" && t.status !== "released" && t.review?.pr === p.number && (t.review.head === p.headRefOid || ["working", "waiting", "monitoring"].includes(t.status))));
}

export const repoSlugOf = (prUrl: string) => /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(prUrl)?.[1] ?? "";

export function newReviewTask(job: Job, pr: OpenPr, now: number): Task {
  const ticket = { source: "github" as const, id: `pr-${pr.number}`, title: `Review: ${pr.title}`, url: pr.url };
  return {
    id: newId("task"), jobId: job.id, kind: "review", ticket,
    review: { repo: repoSlugOf(pr.url), pr: pr.number, url: pr.url, title: pr.title, author: pr.author?.login ?? "", head: pr.headRefOid, base: pr.baseRefName },
    worktree: join(WORK_DIR, `review-pr-${pr.number}-${pr.headRefOid.slice(0, 7)}`), branch: `review/pr-${pr.number}`,
    feature: newShipFeature(ticket, `review-pr-${pr.number}`, now, "In Review"),
    status: "working", sessions: {}, accountIds: {}, reviewsDone: 0, threadsSeen: [], startedAt: now, updatedAt: now, activity: "queued for review",
  } as Task;
}

/** one scan: start a review task for each PR that wants one, up to the free slots */
export async function scanReviews(job: Job, slots: number, gh: (args: string[], cwd: string) => Promise<string> = (args, cwd) => sh("gh", args, cwd)): Promise<OpenPr[]> {
  if (!job.reviewer) throw new Error(`Review scanner ${job.name} has no --reviewer login`);
  const prs = JSON.parse(await gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,url,headRefOid,baseRefName,isDraft,author,assignees,reviewRequests"], job.repo)) as OpenPr[];
  return reviewCandidates(prs, job.reviewer, loadState().tasks).slice(0, Math.max(0, slots));
}

// ── parsing what the agents return ─────────────────────────────────────────────────────────

const SEVERITY = ["critical", "high", "medium", "low"];
const CATEGORY = ["logic", "redundant", "style", "tests", "comments", "scaling"];
export type RawFinding = { severity?: string; category?: string; title?: string; file?: string; line?: number; problem?: string; fix?: string; comment?: string };

/** the JSON after a marker like [review-findings], fenced or bare; undefined when there is none */
export function jsonAfter(text: string, marker: string): unknown {
  const at = text.lastIndexOf(marker);
  const tail = at >= 0 ? text.slice(at + marker.length) : text;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(tail)?.[1];
  const candidates = [fenced, tail.trim()].filter((x): x is string => !!x);
  for (const c of candidates) { try { return JSON.parse(c); } catch { /* next */ } }
  return undefined;
}

export function cleanFindings(raw: unknown): RawFinding[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as any).findings) ? (raw as any).findings : [];
  return list.filter((f: any) => f && typeof f === "object" && typeof f.title === "string" && typeof f.comment === "string").map((f: any) => ({
    severity: SEVERITY.includes(String(f.severity).toLowerCase()) ? String(f.severity).toLowerCase() : "medium",
    category: CATEGORY.includes(String(f.category).toLowerCase()) ? String(f.category).toLowerCase() : "logic",
    title: f.title.trim(), file: typeof f.file === "string" ? f.file.replace(/^\.?\//, "") : undefined,
    line: Number.isInteger(f.line) && f.line > 0 ? f.line : undefined,
    problem: typeof f.problem === "string" ? f.problem : undefined, fix: typeof f.fix === "string" ? f.fix : undefined, comment: f.comment.trim(),
  }));
}

/** the standard review file: every finding queued to post */
export function buildReview(t: ReviewTarget, findings: RawFinding[], o: { tldr?: string; headline?: string; at: string }): Review {
  return parseReview(JSON.stringify({
    version: 1, repo: t.repo, pr: t.pr, url: t.url, title: t.title, head: t.head, base: t.base, reviewedAt: o.at,
    whatItDoes: o.tldr, headline: o.headline, method: "Consort auto review: frontier overview, Opus/Sol reviewer swarm, frontier verification",
    flows: [], appendix: [], wellBuilt: [], orderOfWork: [], submissions: [],
    findings: findings.map((f, i) => ({ id: `F${i + 1}`, kind: "defect", severity: f.severity, category: f.category, title: f.title, file: f.file, line: f.line, problem: f.problem, fix: f.fix, comment: f.comment, status: "approved" })),
  }));
}

export const blocking = <F extends Pick<Finding, "severity">>(findings: F[]) => findings.filter((f) => f.severity === "critical" || f.severity === "high");
export const counts = (findings: Pick<Finding, "severity">[]) => SEVERITY.map((s) => [s, findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n);
export const countLine = (findings: Pick<Finding, "severity">[]) => counts(findings).map(([s, n]) => `${n} ${s}`).join(", ") || "no findings";
export const saysYes = (reply: string) => /^\s*(?:y|yes|yep|yeah|approve|approved|ok|okay|lgtm|ship it|go|go ahead|do it|sure)\b/i.test(reply);

export function approvalQuestion(t: ReviewTarget, review: Review, postedUrl: string | undefined): string {
  const top = review.findings.slice(0, 5).map((f) => `• ${f.severity ?? "note"}: ${f.title}${f.file ? ` (\`${f.file}${f.line ? `:${f.line}` : ""}\`)` : ""}`).join("\n");
  return [
    `*Approve PR #${t.pr}?* ${t.title} by @${t.author}`,
    `• TL;DR: ${review.whatItDoes ?? review.headline ?? "see the PR"}`,
    `• Findings: ${countLine(review.findings)}; nothing Critical or High.${postedUrl ? ` Comments are posted: <${postedUrl}|review>.` : ""}`,
    ...(top ? [top] : []),
    `• PR: <${t.url}|#${t.pr}>`,
    `Reply *yes* to approve, or anything else to leave it unapproved.`,
  ].join("\n");
}

// ── prompts ────────────────────────────────────────────────────────────────────────────────

const RULES_NOTE = (wt: string) => existsSync(join(wt, ".ai-review-rules.md")) ? "The repository's own review rules are in .ai-review-rules.md: read them first; a rule's stated severity always wins." : "The repository has no .ai-review-rules.md; judge by its existing conventions.";

export const OVERVIEW_PROMPT = (t: ReviewTarget, wt: string) => `## Review step 1 of 3: understand the repository and plan the review

You lead an automatic review of PR #${t.pr} "${t.title}" by @${t.author} into ${t.base}. The PR head is checked out in this worktree. Do not change source files; write only under .consort/review/.
${RULES_NOTE(wt)}

1. Learn how this repository is built: its layout and layering, where each kind of code lives, naming, data access, error handling, config and secrets, background jobs, tests, and how existing features are organised so they scale. Read the docs and the existing modules closest to what the PR touches.
2. Read the change: \`git diff origin/${t.base}...HEAD --stat\`, then the diff itself.
3. Write .consort/review/OVERVIEW.md: a 2-3 sentence TL;DR of what the PR does; the conventions and rules that apply to it; where it could break at scale; the risky areas.
4. Write .consort/review/plan.json: {"tldr": "<2-3 sentences>", "slices": [{"id": "s1", "title": "<area>", "files": ["<changed files in this area>"], "related": ["<callers, similar existing modules, schemas to compare against>"], "focus": "<what to check here>"}]}. 3 to 10 slices, together covering every changed file, each small enough for one reviewer to crawl thoroughly. Group by area of the code, not by commit.
Reply with one line when both files are written.`;

export const SLICE_PROMPT = (t: ReviewTarget, wt: string, slice: { id: string; title: string; files: string[]; related?: string[]; focus?: string }) => `## Review one area of PR #${t.pr} "${t.title}"

Read .consort/review/OVERVIEW.md first. ${RULES_NOTE(wt)}
Your area: ${slice.title}
Changed files: ${slice.files.join(", ")}
${slice.related?.length ? `Compare against: ${slice.related.join(", ")}\n` : ""}${slice.focus ? `Focus: ${slice.focus}\n` : ""}
Crawl: read each changed file in full, the code that calls it, and the existing code that does the same kind of thing, so you judge it against how this repository already works. The diff is \`git diff origin/${t.base}...HEAD -- <file>\`.
Flag, with evidence:
- correctness bugs and broken flows;
- what will not scale: unbounded queries or loops, N+1 queries, missing pagination or indexes, heavy work per request, memory growth, missing limits or timeouts;
- convention breaks: code in the wrong layer or folder, naming that differs from its neighbours, a new pattern where a shared helper or existing pattern exists, duplicated logic, organisation that will not hold as the feature grows;
- security and secrets handling, missing tests for new behaviour, and every violation of .ai-review-rules.md at the rule's severity.
Do not flag what a linter or formatter catches, or taste with no consequence. Point each finding at a changed line at the PR head when you can.
Severity: critical = breaks production, data or security; high = a real bug, or a scaling or convention problem that must be fixed before merge; medium = should be fixed; low = worth a mention.
Reply with [review-findings] followed by a \`\`\`json array: [{"severity", "category": "logic|redundant|style|tests|comments|scaling", "title": "<the consequence, one line>", "file", "line", "problem", "fix", "comment": "<the GitHub comment to post: plain, direct, 1-4 sentences, with the fix>"}]. An empty array when you find nothing.`;

export const FINAL_PROMPT = (t: ReviewTarget, wt: string, reviewers: number) => `## Review step 3 of 3: verify and settle the findings

${reviewers} reviewers' raw findings for PR #${t.pr} are in .consort/review/swarm.json. ${RULES_NOTE(wt)}
For each finding, open the file at that line and check it is real at the PR head. Drop false positives and anything a linter catches; merge duplicates; move file/line to a changed line where you can; settle the severity (a rule in .ai-review-rules.md wins; otherwise critical = breaks production, data or security; high = a real bug or a scaling or convention problem that must be fixed before merge; medium = should fix; low = worth a mention); tighten each comment so it is ready to post.
Reply with [review-final] followed by a \`\`\`json object: {"tldr": "<2-3 sentences: what the PR does>", "headline": "<one-line verdict>", "findings": [same shape as the raw findings]}.`;

// ── the worker ─────────────────────────────────────────────────────────────────────────────

export async function reviewTask(taskId: string): Promise<void> {
  const state = loadState();
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task?.review) throw new Error(`No review task ${taskId}.`);
  const job = state.jobs.find((j) => j.id === task.jobId);
  if (!job) throw new Error(`Review task ${taskId} belongs to a scanner that no longer exists.`);
  const t = task.review;
  const log = (line: string) => console.log(`${new Date().toISOString()} [review #${t.pr}] ${line}`);
  const activity = (line: string) => { log(line); updateTask(taskId, { activity: line, status: "working" }); };
  updateTask(taskId, { pid: process.pid });

  // Slack: one thread per review
  const slack = state.slack ? new Slack(state.slack) : undefined;
  const links = { ticket: t.url, github: t.url, heading: `🔎 PR #${t.pr} ${t.title}`.slice(0, 80) };
  let thread = task.slackThread;
  const say = async (text: string, status: "RUNNING" | "WAITING" | "COMPLETED" | "STOPPED" = "RUNNING") => {
    log(text.replace(/\n/g, " ⏎ "));
    if (!slack) return undefined;
    const ts = await slack.post(slackStatus(slackMessage("update", text), status, links), thread).catch((e) => { log(`slack failed: ${e.message}`); return undefined; });
    if (!thread && ts) { thread = ts; updateTask(taskId, { slackThread: ts }); }
    return ts;
  };
  if (!thread) await say(`Reviewing PR #${t.pr} by @${t.author} at \`${t.head.slice(0, 7)}\`: repo overview first, then a reviewer swarm`);

  // 1. worktree at the PR head, the root .env files, the environment
  const wt = task.worktree;
  if (!existsSync(wt)) {
    activity("checking out the PR head");
    await sh("git", ["fetch", "origin", `pull/${t.pr}/head`, t.base], job.repo);
    await sh("git", ["worktree", "add", "--detach", wt, t.head], job.repo);
  }
  for (const f of readdirSync(job.repo).filter((n) => /^\.env(?:\..+)?$/.test(n) && !/\.(?:example|sample|template)$/.test(n))) {
    if (!existsSync(join(wt, f))) copyFileSync(join(job.repo, f), join(wt, f));
  }
  mkdirSync(join(wt, ".consort", "review"), { recursive: true });
  const env = await allocateEnvironment(loadState().tasks.find((x) => x.id === taskId)!);

  const models = seedModels();
  // model settings: the review scanner's own, else those of a build scanner on the same repository
  const policy = job.modelPolicy ?? state.jobs.find((j) => j.repo === job.repo && j.source !== "review" && j.modelPolicy)?.modelPolicy;
  const turn = async (role: "frontier" | "swarm" | "setup", prompt: string, readOnly: boolean, timeoutMs: number): Promise<string> => {
    const tried = new Set<string>();
    for (let attempt = 0; attempt < 8; attempt++) {
      const now = Date.now();
      const open = loadState().accounts.filter((a) => !(a.blockedUntil && a.blockedUntil > now) && !tried.has(a.id));
      if (!open.length) { tried.clear(); await new Promise((r) => setTimeout(r, 60_000)); continue; }
      const modelOn = (a: Account) => role === "frontier" ? selectCliModel(a.provider, models[a.provider], "frontier", policy) : role === "swarm" ? oversightModel(a.provider, policy) : selectCliModel(a.provider, models[a.provider], "implementation", policy);
      const usage = await usageFor(open);
      const who = open.filter((a) => !modelBlock(usage.get(a.id), modelOn(a)) && !usageBlock(usage.get(a.id) ?? { keyId: a.id, at: 0, windows: [] }, now))
        .sort((x, y) => (modelLoad(usage.get(x.id), modelOn(x)) ?? 1_000) - (modelLoad(usage.get(y.id), modelOn(y)) ?? 1_000) || (x.lastUsedAt ?? 0) - (y.lastUsedAt ?? 0))[0];
      if (!who) { open.forEach((a) => tried.add(a.id)); continue; }
      const model = modelOn(who);
      touchAccount(who.id);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      const started = Date.now();
      try {
        const res = await withAgentTurn(taskId, who.id, () => runTurn({ cwd: wt, model, account: who, readOnly, signal: abort.signal, maxDelegates: 0, effort: role === "frontier" ? "high" : "medium", env: env as unknown as Record<string, string>,
          prompt: `${HEADLESS_RULES}\n\n${prompt}\n\n${ENVIRONMENT_RULES(env)}` }));
        updateTask(taskId, (x) => ({ ...(res.usage?.length ? { cost: addTurnCost(x.cost, res.usage) } : {}), turnHistory: [...(x.turnHistory ?? []), { at: started, stage: `review ${role}`, role, provider: who.provider as Provider, model, durationMs: Date.now() - started, usage: res.usage, error: res.error ?? res.limit?.text }] }));
        if (res.limit) { blockAccount(who.id, res.limit.resetsAt, res.limit.text); tried.add(who.id); continue; }
        if (res.error || !res.text.trim()) { log(`${role} turn failed on ${who.name}: ${res.error ?? "empty reply"}`); tried.add(who.id); continue; }
        return res.text;
      } finally { clearTimeout(timer); }
    }
    throw new Error(`The ${role} review step failed on every account`);
  };

  try {
    if (!loadState().tasks.find((x) => x.id === taskId)?.envReadyAt) {
      activity("setting up databases and services for the review");
      // the repo's setup is shared with its build tasks: start from it, and save what this review proves
      await turn("setup", environmentPrompt(job.repo, wt, env), false, 30 * 60_000)
        .then(() => { if (saveRepoEnv(job.repo, wt)) log("saved this repo's environment setup"); })
        .catch((e) => log(`environment setup incomplete: ${(e as Error).message}`));
      updateTask(taskId, { envReadyAt: Date.now() });
    }

    // 2. the frontier overview and plan
    const planFile = join(wt, ".consort", "review", "plan.json");
    if (!existsSync(planFile)) {
      activity("frontier model: reading the repository and planning the review");
      await turn("frontier", OVERVIEW_PROMPT(t, wt), false, 45 * 60_000);
    }
    const plan = JSON.parse(readFileSync(planFile, "utf8")) as { tldr?: string; slices?: { id: string; title: string; files: string[]; related?: string[]; focus?: string }[] };
    const slices = (plan.slices ?? []).filter((s) => s && Array.isArray(s.files) && s.files.length);
    if (!slices.length) throw new Error("The overview wrote no review slices");
    await say(`Plan: ${slices.length} areas, reviewed in parallel on Opus/Sol: ${slices.map((s) => s.title).join("; ")}`);

    // 3. the swarm, one read-only reviewer per area, as many at once as capacity allows
    activity(`reviewer swarm: ${slices.length} areas in parallel`);
    const raw: RawFinding[] = [];
    const results = await Promise.allSettled(slices.map(async (slice) => {
      const text = await turn("swarm", SLICE_PROMPT(t, wt, slice), true, 45 * 60_000);
      const found = cleanFindings(jsonAfter(text, "[review-findings]"));
      raw.push(...found);
      log(`area ${slice.id} (${slice.title}): ${found.length} findings`);
    }));
    const failedAreas = results.filter((r) => r.status === "rejected").length;
    writeFileSync(join(wt, ".consort", "review", "swarm.json"), JSON.stringify(raw, null, 2));

    // 4. the frontier verification
    activity(`frontier model: verifying ${raw.length} findings`);
    const finalText = raw.length ? await turn("frontier", FINAL_PROMPT(t, wt, slices.length - failedAreas), true, 45 * 60_000) : "[review-final] {\"findings\": []}";
    const final = jsonAfter(finalText, "[review-final]") as { tldr?: string; headline?: string } | undefined;
    const review = buildReview(t, cleanFindings(final), { tldr: final?.tldr ?? plan.tldr, headline: final?.headline, at: new Date().toISOString() });
    const reviewPath = join(wt, ".consort", "review", `pr-${t.pr}.review.json`);
    writeFileSync(reviewPath, serializeReview(review));
    mkdirSync(join(HOME, "reviews"), { recursive: true });
    writeFileSync(join(HOME, "reviews", `${t.repo.replace("/", "-")}-pr-${t.pr}-${t.head.slice(0, 7)}.review.json`), serializeReview(review));

    // 5. post, then approve only on the owner's word
    const severe = blocking(review.findings);
    const summary = `${review.whatItDoes ?? plan.tldr ?? ""}`.trim();
    if (severe.length) {
      activity(`posting ${review.findings.length} comments with Request changes`);
      const posted = await postReview(review, review.findings, "REQUEST_CHANGES", `Automatic review: ${countLine(review.findings)}. The Critical and High items need fixing before this merges.${summary ? `\n\n${summary}` : ""}`, wt);
      await say(`Requested changes on <${t.url}|PR #${t.pr}>: ${countLine(review.findings)}.\n${severe.slice(0, 5).map((f) => `• ${f.severity}: ${f.title}`).join("\n")}\n• Review: <${posted.url}|on GitHub>`, "COMPLETED");
      updateTask(taskId, { status: "done", finishedAt: Date.now(), note: `requested changes (${countLine(review.findings)})`, activity: "review posted: changes requested" });
    } else {
      const posted = review.findings.length ? await postReview(review, review.findings, "COMMENT", `Automatic review: ${countLine(review.findings)}; nothing Critical or High.`, wt) : undefined;
      activity("waiting for the owner's word to approve");
      const ts = await say(approvalQuestion(t, review, posted?.url), "WAITING");
      updateTask(taskId, { status: "waiting", pendingQuestion: { questions: [`Approve PR #${t.pr}?`], afterTs: ts ?? String(Date.now() / 1000) } });
      const answer = slack && thread && ts ? await slack.waitForReply(thread, ts, { pollMs: 15_000 }) : undefined;
      updateTask(taskId, { pendingQuestion: undefined, status: "working" });
      if (answer && saysYes(answer)) {
        const approved = await postReview(review, [], "APPROVE", `Approved after an automatic review (${countLine(review.findings)}) and the reviewer's confirmation.`, wt);
        await say(approved.event === "APPROVE" ? `Approved <${t.url}|PR #${t.pr}>.` : `Could not approve <${t.url}|PR #${t.pr}> (it is your own PR); posted the note as a comment.`, "COMPLETED");
        updateTask(taskId, { status: "done", finishedAt: Date.now(), note: approved.event === "APPROVE" ? "approved" : "commented (own PR)", activity: "review done" });
      } else {
        await say(`Left <${t.url}|PR #${t.pr}> unapproved${answer ? ` (you said: ${answer.slice(0, 80)})` : ""}.`, "COMPLETED");
        updateTask(taskId, { status: "done", finishedAt: Date.now(), note: slack ? "not approved" : "not approved: approval needs Slack (consort-cli slack set …)", activity: "review done, not approved" });
      }
    }
  } finally {
    await cleanupEnvironment(env.CONSORT_RUN).catch(() => undefined);
    const after = loadState().tasks.find((x) => x.id === taskId);
    if (after?.status === "done") {
      await sh("git", ["worktree", "remove", "--force", wt], job.repo).catch(() => undefined);
      updateTask(taskId, { portBase: undefined, envReadyAt: undefined });
    }
  }
}

