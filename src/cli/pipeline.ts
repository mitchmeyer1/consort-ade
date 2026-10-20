import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyShipChange, newShipFeature, parseShipMarkers, prNumberFromUrl, shipBranch, shipFolder, shipSlug, stripShipMarkers, type ShipFeature, type ShipTicket } from "../shared/ship.ts";
import { shipPrompt } from "../shared/shipPrompt.ts";
import { DEFAULT_BLOCK_MS, earliestUnblock, EVIDENCE_PROMPT, parseAskUser, pickAccount, prReadiness, RESPOND_TO_REVIEW, reviewRotation, seedModels, slackLines, stripAskUser, suggestReviewers } from "../shared/headless.ts";
import { describeLimit, resetLabel } from "../shared/seatPool.ts";
import { parseReview, reviewSummary, type ReviewSummary } from "../shared/review.ts";
import { modelTiers } from "../shared/modelTiers.ts";
import { excludeConsortDir, fetchTicket, writeTicketFile } from "../main/ship";
import { addWorktree } from "../main/git";
import type { Provider } from "../shared/types";
import { runTurn, packageRoot } from "./agent";
import { readPr, requestReviewers, shortlogForBranch, whoAmI } from "./prmonitor";
import { findBrowser, publishEvidence, writeScreenshotHelper } from "./evidence";
import { Slack } from "./slack";
import { sourceFor, type Source } from "./sources";
import { blockAccount, loadState, touchAccount, updateTask, WORK_DIR, type Account, type Job, type Task } from "./state";

/**
 * One ticket, start to ready-to-merge, with nobody watching: the /ship stages in a worktree of
 * their own, questions relayed over Slack, three review rounds on rotating models, then a watch
 * on the PR that answers human reviewers and pings the owner when it is ready. This is the
 * body of `consort-cli work <task>`; the daemon runs one process per task.
 */

const run = promisify(execFile);
const MAX_TURNS = 80;
const PR_POLL_MS = 15 * 60_000;
const STUCK_AFTER = 3;

const log = (task: Task, line: string) => console.log(`${new Date().toISOString()} [${task.ticket.id}] ${line}`);

/** which providers this box has at least one account for */
const providersOf = (accounts: Account[]) => ({ claude: accounts.some((a) => a.provider === "claude"), codex: accounts.some((a) => a.provider === "codex") });

export async function workTask(taskId: string): Promise<void> {
  const state = loadState();
  let task = state.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`No task ${taskId}.`);
  const job = state.jobs.find((j) => j.id === task!.jobId);
  if (!job) throw new Error(`Task ${taskId} belongs to a job that no longer exists.`);
  const source = sourceFor(job, state.clickupKey);
  const slack = state.slack ? new Slack(state.slack) : undefined;
  const have = providersOf(state.accounts);
  const builderProvider: Provider | undefined = have.claude ? "claude" : have.codex ? "codex" : undefined;
  if (!builderProvider) throw new Error("No AI accounts: run `consort-cli accounts add` first.");
  const models = seedModels();
  const builderModel = modelTiers(builderProvider, models[builderProvider]).orchestrator;
  const rotation = job.reviewModels?.length ? job.reviewModels : reviewRotation({ claude: have.claude ? models.claude : undefined, codex: have.codex ? models.codex : undefined });

  updateTask(task.id, { pid: process.pid, status: "working", activity: "starting" });
  task = loadState().tasks.find((t) => t.id === taskId)!;
  const activity = (line: string) => { updateTask(task.id, { activity: line }); };

  // the worktree, cut from the base branch the job names; a restart finds it already there
  if (!existsSync(task.worktree)) {
    log(task, `creating worktree ${task.worktree} on ${task.branch} from ${job.base}`);
    await run("git", ["fetch", "origin", job.base], { cwd: job.repo, timeout: 120_000 }).catch(() => {});
    await addWorktree(job.repo, shipFolder(shipSlug(task.ticket.title), task.ticket.id), task.branch, `origin/${job.base}`, WORK_DIR);
  }
  await excludeConsortDir(task.worktree).catch(() => {});
  const fetched = await fetchTicket(task.ticket, { repoPath: job.repo, clickupKey: state.clickupKey });
  const ticketBody = writeTicketFile(task.worktree, task.ticket, fetched);

  // one Slack thread per task
  let thread = task.slackThread;
  if (slack && !thread) {
    thread = await slack.post(slackLines.claimed(task.ticket.title, task.ticket.url, task.branch));
    updateTask(task.id, { slackThread: thread });
  }
  const say = async (text: string) => { log(task, text.replace(/\n/g, " ⏎ ")); if (slack && thread) await slack.post(text, thread).catch((e) => log(task, `slack failed: ${e.message}`)); };
  const finish = (status: Task["status"], note?: string) => updateTask(task.id, { status, note, finishedAt: Date.now(), activity: note ?? status });
  const tell = async (text: string) => { await say(text); await source.comment(task.ticket.id, text.replace(/<([^|>]+)\|([^>]+)>/g, "$2 ($1)")).catch((e) => log(task, `ticket comment failed: ${e.message}`)); };

  /** ask the owner on Slack and wait; without Slack the question is logged and the run stops */
  const ask = async (questions: string[]): Promise<string> => {
    updateTask(task.id, { status: "waiting", note: questions.join(" | "), activity: `waiting on Slack: ${questions[0].slice(0, 80)}` });
    if (!slack || !thread) throw new Error(`Needs the owner but Slack is not configured. Questions: ${questions.join(" | ")}`);
    const ts = await slack.post(slackLines.question(questions, task.ticket.url), thread);
    log(task, `waiting on Slack for ${questions.length} answer(s)`);
    const reply = await slack.waitForReply(thread, ts, { onTick: () => updateTask(task.id, {}) });
    updateTask(task.id, { status: "working", note: undefined });
    return reply ?? "";
  };

  /**
   * One agent turn on a provider, with the ship markers applied to the feature. The account is
   * the task's sticky one for that provider; a usage limit blocks it, drops the provider's
   * session (another login cannot resume it; the stage handlers pick up from disk), and the
   * same prompt goes again on the next account. With every account of the provider out, the
   * worker sleeps until the first one frees and says so on Slack.
   */
  let feature: ShipFeature = task.feature;
  let pendingUser: string | undefined;
  let idle = 0;
  const turn = async (prompt: string, provider: Provider = builderProvider, model = builderModel, resume = true): Promise<string> => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const live = loadState();
      const cur = live.tasks.find((t) => t.id === taskId)!;
      let who = pickAccount(live.accounts, provider, Date.now(), cur.accountIds[provider]);
      if (!who) {
        const until = earliestUnblock(live.accounts, provider, Date.now()) ?? Date.now() + DEFAULT_BLOCK_MS;
        await say(`Every ${provider} account is at its usage limit; the first frees up ${resetLabel(until)}. Waiting.`);
        activity(`all ${provider} accounts at their limit until ${resetLabel(until)}`);
        await new Promise((r) => setTimeout(r, Math.max(30_000, until - Date.now())));
        continue;
      }
      if (cur.accountIds[provider] !== who.id) updateTask(task.id, (t) => ({ accountIds: { ...t.accountIds, [provider]: who!.id } }));
      touchAccount(who.id);
      const session = resume ? cur.sessions[provider] : undefined;
      const res = await runTurn({ cwd: task.worktree, prompt, model, account: who, resume: session, onText: (t) => log(task, `agent: ${t.slice(0, 200).replace(/\n/g, " ")}`) });
      if (res.limit) {
        blockAccount(who.id, res.limit.resetsAt, res.limit.text);
        updateTask(task.id, (t) => ({ sessions: { ...t.sessions, [provider]: undefined } }));
        await say(`${who.name} hit its ${describeLimit(res.limit)}${res.limit.resetsAt ? ` (resets ${resetLabel(res.limit.resetsAt)})` : ""}; moving to another ${provider} account.`);
        continue;
      }
      if (res.sessionId && resume) updateTask(task.id, (t) => ({ sessions: { ...t.sessions, [provider]: res.sessionId } }));
      if (res.error) throw new Error(`${provider} turn failed: ${res.error}`);
      return res.text;
    }
    throw new Error(`gave up after repeated usage limits on ${provider}`);
  };
  const reviewSummaryOf = (pr: number): ReviewSummary | undefined => {
    const file = join(task.worktree, ".consort", "pr-review", `pr-${pr}.review.json`);
    try { return reviewSummary(parseReview(readFileSync(file, "utf8"))); } catch { return undefined; }
  };
  const applyReply = async (text: string) => {
    const change = parseShipMarkers(text);
    const before = feature;
    if (change) feature = applyShipChange(feature, change, Date.now());
    updateTask(task.id, { feature });
    if (feature.stage !== before.stage) {
      await tell(slackLines.stage(feature.stage, change?.note));
      if (feature.stage === "In Review") await source.setStatus(task.ticket.id, "review").catch((e) => log(task, `status failed: ${e.message}`));
    }
    for (const pr of feature.prs) if (!before.prs.includes(pr)) await say(slackLines.pr(pr));
    const questions = parseAskUser(text);
    if (questions.length) { const answer = await ask(questions); pendingUser = `The owner answered on Slack:\n\n${answer}\n\nContinue from where you stopped; apply the answers and do not ask these again.`; idle = 0; return true; }
    idle = feature.stage === before.stage && !change ? idle + 1 : 0;
    return false;
  };

  // ── the stages, Grilling through In Review ──────────────────────────────────────────────
  for (let n = 0; n < MAX_TURNS && feature.stage !== "In Review" && feature.stage !== "Merged" && feature.stage !== "Closed"; n++) {
    const form = feature.stage === "Ready to Test" ? "approve" as const : "resume" as const;
    const prompt = pendingUser ?? shipPrompt({ feature, form: { form }, worktree: task.worktree, branch: task.branch, base: `origin/${job.base}`, ticketBody, headless: true });
    pendingUser = undefined;
    activity(`${feature.stage}: turn ${n + 1}`);
    const text = await turn(prompt);
    log(task, `turn ${n + 1} at ${feature.stage}: ${stripAskUser(stripShipMarkers(text)).slice(0, 300).replace(/\n/g, " ")}`);
    await applyReply(text);
    if (idle >= STUCK_AFTER) {
      const answer = await ask([`I have taken ${idle} turns at ${feature.stage} without moving. Last reply: "${stripShipMarkers(text).slice(0, 400)}". What should I do?`]);
      pendingUser = `The owner says: ${answer}`;
      idle = 0;
    }
  }
  if (feature.stage !== "In Review") { finish("failed", `stopped at ${feature.stage} after ${MAX_TURNS} turns`); await say(slackLines.stuck(`${MAX_TURNS} turns without reaching In Review`)); return; }
  const prUrl = feature.prs.at(-1);
  const pr = prUrl ? prNumberFromUrl(prUrl) : undefined;
  if (!pr) { finish("failed", "In Review without a PR"); await say(slackLines.stuck("the feature reached In Review without a PR")); return; }

  // ── three review rounds on rotating models, each followed by a fix turn ───────────────────
  for (let round = task.reviewsDone + 1; round <= rotation.length; round++) {
    const pick = rotation[round - 1];
    const provider: Provider = have[pick.provider] ? pick.provider : builderProvider;
    const model = have[pick.provider] ? pick.model : builderModel;
    log(task, `review round ${round} on ${provider}:${model}`);
    activity(`review round ${round} on ${model}`);
    const delegate = modelTiers(provider, models[provider]).delegate;
    await turn(reviewSkillPrompt(task.worktree, pr, delegate), provider, model, false);
    const summary = reviewSummaryOf(pr);
    await say(slackLines.review(round, model, summary?.total ?? 0));
    feature = { ...feature, review: { chatId: `cli-${round}`, pr, round, startedAt: Date.now(), doneAt: Date.now() }, reviewRound: round };
    updateTask(task.id, { feature, reviewsDone: round });
    if (!summary || summary.total === 0) continue;
    activity(`fixing round ${round} findings (${summary.total})`);
    const fix = await turn(shipPrompt({ feature, form: { form: "pr-loop" }, worktree: task.worktree, branch: task.branch, base: `origin/${job.base}`, review: { running: false, summary }, headless: true }));
    const asked = await applyReply(fix);
    if (asked && pendingUser) { const text = await turn(pendingUser); pendingUser = undefined; await applyReply(text); }
  }

  // ── evidence: prove it works, post the proof on the PR and the ticket, cross-linked ──────
  if (!task.feature.evidenceAt) {
    activity("gathering evidence");
    try {
      const browser = await findBrowser();
      const helper = browser ? writeScreenshotHelper(task.worktree, browser) : undefined;
      const prompt = EVIDENCE_PROMPT({ helper: helper ?? "(no browser on this machine: skip the images, keep the text items)", ticketUrl: task.ticket.url, prUrl: prUrl!, worktree: task.worktree });
      const text = await turn(helper ? prompt : `${prompt}\n\nThere is no Chrome on this machine, so no screenshots can be taken; text evidence only.`);
      const asked = await applyReply(text);
      if (asked && pendingUser) { const t2 = await turn(pendingUser); pendingUser = undefined; await applyReply(t2); }
      const published = await publishEvidence({ worktree: task.worktree, repo: job.repo, ticket: task.ticket, pr, prUrl: prUrl!, source, clickupKey: state.clickupKey });
      feature = { ...feature, evidenceAt: Date.now() };
      updateTask(task.id, { feature });
      await say(published ? `Evidence posted: ${published.items} item${published.items === 1 ? "" : "s"}, ${published.images} image${published.images === 1 ? "" : "s"}${published.hosting === "branch" ? " (on the consort-evidence branch)" : ""}, on the PR${published.ticketComment ? " and the ticket" : ""}.` : "No evidence manifest was written; moving on without it.");
    } catch (e) { await say(`Evidence step failed: ${(e as Error).message.split("\n")[0]}. Moving on.`); }
  }

  // ── reviewers, then the watch ─────────────────────────────────────────────────────────────
  const me = await whoAmI(job.repo);
  const suggested = suggestReviewers(await shortlogForBranch(task.worktree, `origin/${job.base}`).catch(() => ""), [me]);
  if (suggested.length) { await requestReviewers(job.repo, pr, suggested).catch((e) => log(task, `review request failed: ${e.message}`)); await say(slackLines.reviewers(suggested)); }
  updateTask(task.id, { status: "monitoring", activity: "watching the PR" });
  await say(`Watching the PR every ${PR_POLL_MS / 60_000} minutes: I will answer review comments and tell you when it is ready to merge.`);

  for (;;) {
    const state = await readPr(job.repo, pr).catch((e) => { log(task, `pr read failed: ${e.message}`); return undefined; });
    updateTask(task.id, { lastPrCheckAt: Date.now() });
    if (state) {
      if (state.state !== "OPEN") { await tell(`The PR is ${state.state.toLowerCase()}. Done here.`); finish("done", `PR ${state.state.toLowerCase()}`); if (state.state === "MERGED") await source.setStatus(task.ticket.id, "done").catch(() => {}); return; }
      const seen = new Set(loadState().tasks.find((t) => t.id === taskId)?.threadsSeen ?? []);
      const fresh = state.unresolved.filter((t) => !seen.has(t.id) && t.author && t.author !== me);
      if (fresh.length) {
        log(task, `${fresh.length} new review thread(s)`);
        activity(`answering ${fresh.length} review thread${fresh.length === 1 ? "" : "s"}`);
        const text = await turn(RESPOND_TO_REVIEW(fresh));
        updateTask(task.id, (t) => ({ threadsSeen: [...t.threadsSeen, ...fresh.map((f) => f.id)] }));
        const asked = await applyReply(text);
        if (asked && pendingUser) { const t2 = await turn(pendingUser); pendingUser = undefined; await applyReply(t2); }
        await say(`Answered ${fresh.length} review thread${fresh.length === 1 ? "" : "s"}; pushed what was clear.`);
        continue; // re-read straight away
      }
      const ready = prReadiness(state, [me]);
      if (ready.ready) {
        await tell(slackLines.ready(state.url));
        finish("ready", "ready to merge");
        return;
      }
      log(task, `not ready: ${ready.reasons.join(", ")}`);
      activity(`watching PR: ${ready.reasons.join(", ")}`);
    }
    await new Promise((r) => setTimeout(r, PR_POLL_MS));
  }
}

/** the pr-writeup skill as the app sends it, assembled from the package's skills folder */
export function reviewSkillPrompt(worktree: string, pr: number, delegateModel?: string): string {
  const dir = join(packageRoot(), "skills", "pr-writeup");
  const skill = readFileSync(join(dir, "SKILL.md"), "utf8").replace(/^---[\s\S]*?---\n/, "");
  const categories = readFileSync(join(dir, "categories.md"), "utf8");
  const reviewDir = join(worktree, ".consort", "pr-review");
  mkdirSync(join(reviewDir, "agents"), { recursive: true });
  writeFileSync(join(reviewDir, "categories.md"), categories);
  const tier = delegateModel ? `You are the orchestrator. Dispatch every delegated agent on \`${delegateModel}\`.\n\n` : "";
  return `${tier}Nobody is watching this chat; keep updates to one line per phase. Dispatch review agents with \`run_in_background: false\`, a whole wave in one message. Shared context goes in .consort/pr-review/brief.md once; the agent brief is at .consort/pr-review/categories.md. Each agent writes its report to .consort/pr-review/agents/<slug>.md.

Run the following skill with argument: ${pr} in ${worktree}. Its sibling files live in ${dir}.
The deliverable is the review file: write it to .consort/pr-review/pr-${pr}.review.json in the worktree, in the schema the skill gives. Do not post comments to GitHub yourself.

${skill}

## Review rubric you apply in verification

${categories}`;
}

/** what the daemon records when it claims a ticket; the worker does the rest */
export function newTask(job: Job, ticket: ShipTicket, branchPrefix: string | undefined, now: number): Omit<Task, "id"> {
  const slug = shipSlug(ticket.title);
  const branch = shipBranch(branchPrefix, slug, ticket.id);
  return {
    jobId: job.id, ticket, branch, worktree: join(WORK_DIR, shipFolder(slug, ticket.id)),
    feature: newShipFeature(ticket, slug, now), status: "working", sessions: {}, accountIds: {}, reviewsDone: 0, threadsSeen: [],
    startedAt: now, updatedAt: now,
  };
}
