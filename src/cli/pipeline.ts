import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyShipChange, newShipFeature, parseShipMarkers, prNumberFromUrl, shipBranch, shipFolder, shipSlug, stripShipMarkers, type ShipFeature, type ShipTicket } from "../shared/ship.ts";
import { shipPrompt } from "../shared/shipPrompt.ts";
import { DEFAULT_BLOCK_MS, earliestUnblock, ENVIRONMENT_PROMPT, ENVIRONMENT_RULES, HEADLESS_RULES, EVIDENCE_PROMPT, VERIFY_EVIDENCE_PROMPT, parseAskUser, observeReviewBatch, pickTurnAccount, prReadiness, RESPOND_TO_REVIEW, reviewRotation, seedModels, slackLines, stripAskUser } from "../shared/headless.ts";
import { describeLimit, resetLabel } from "../shared/seatPool.ts";
import { parseReview, reviewSummary, type ReviewSummary } from "../shared/review.ts";
import { modelTiers } from "../shared/modelTiers.ts";
import { excludeConsortDir, fetchTicket, writeTicketFile } from "../main/ship";
import { addWorktree } from "../main/git";
import type { Provider } from "../shared/types";
import { runTurn, packageRoot, stopAgents } from "./agent";
import { readPr, requestReviewers, reviewerSuggestions, whoAmI } from "./prmonitor";
import { findBrowser, publishEvidence, validateEvidence, writeScreenshotHelper } from "./evidence";
import { allocateEnvironment, cleanupEnvironment } from "./environment";
import { flushTaskNotifications, notifyTask } from "./lifecycle";
import { readUsage } from "./usage";
import { usageBlock } from "../shared/usage.ts";
import { statusEvent } from "./statusLog";
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
const PR_POLL_MS = 3 * 60_000;
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
  const rotation = job.reviewModels?.length ? Array.from({ length: 3 }, (_, i) => job.reviewModels![i % job.reviewModels!.length]) : reviewRotation({ claude: have.claude ? models.claude : undefined, codex: have.codex ? models.codex : undefined });

  updateTask(task.id, { pid: process.pid, activity: "starting" });
  task = loadState().tasks.find((t) => t.id === taskId)!;
  const activity = (line: string) => { updateTask(taskId, { activity: line }); };
  let turnTag = ""; // "t3 · " while a build turn runs, so the live line shows which turn it came from
  // the task's own ports and Docker names, on every turn from here on
  const env = await allocateEnvironment(task!);
  task = loadState().tasks.find((t) => t.id === taskId)!;
  log(task, `environment ${env.CONSORT_RUN} on ports ${env.CONSORT_PORT_RANGE}`);

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
  if (!task.pendingQuestion && task.status !== "monitoring" && task.lifecycle !== "paused") await notifyTask(taskId, "running", "Worker started; preparing the task.");
  const finish = async (status: Task["status"], note?: string) => {
    updateTask(task.id, { status, note, finishedAt: Date.now(), activity: note ?? status });
    await notifyTask(taskId, status === "ready" ? "completed" : "stopped", note ?? status);
    await cleanupEnvironment(env.CONSORT_RUN).then((r) => { if (r.containers || r.networks || r.volumes) log(task, `removed ${r.containers} container(s), ${r.networks} network(s), ${r.volumes} volume(s)`); });
  };
  const tell = async (text: string) => { await say(text); await source.comment(task.ticket.id, text.replace(/<([^|>]+)\|([^>]+)>/g, "$2 ($1)")).catch((e) => log(task, `ticket comment failed: ${e.message}`)); };

  /** ask the owner on Slack and wait; without Slack the question is logged and the run stops */
  const ask = async (questions: string[]): Promise<string> => {
    updateTask(task.id, { status: "waiting", note: questions.join(" | "), activity: `waiting on Slack: ${questions[0].slice(0, 80)}` });
    if (!slack || !thread) throw new Error(`Needs the owner but Slack is not configured. Questions: ${questions.join(" | ")}`);
    const pending = loadState().tasks.find((t) => t.id === taskId)?.pendingQuestion;
    const ts = pending?.afterTs ?? await slack.post(slackLines.question(questions, task.ticket.url), thread);
    updateTask(taskId, { pendingQuestion: { questions, afterTs: ts } });
    await notifyTask(taskId, "paused", "Waiting for your answer in Slack.");
    log(task, `waiting on Slack for ${questions.length} answer(s)`);
    let lastEmptyLog = 0;
    let lastCheckResult: string | undefined;
    const reply = await slack.waitForReply(thread, ts, { onCheck: (result) => {
      if (result !== "answer" && result === lastCheckResult && Date.now() - lastEmptyLog < 60_000) return;
      lastCheckResult = result;
      lastEmptyLog = Date.now();
      statusEvent(result === "answer" ? "success" : result === "error" ? "error" : "warn", result === "answer" ? `Ticket ${task.ticket.id}: answer found in Slack; continuing` : result === "error" ? `Ticket ${task.ticket.id}: Slack reply check failed; retrying` : `Ticket ${task.ticket.id}: no Slack answer yet`);
    }, onTick: () => { updateTask(task.id, {}); void flushTaskNotifications(taskId); } });
    updateTask(task.id, { status: "working", note: undefined, pendingQuestion: undefined });
    await notifyTask(taskId, "running", "Your Slack answer arrived; continuing the task.");
    return reply ?? "";
  };

  /**
   * One agent turn on a provider, with the ship markers applied to the feature. The account is
   * the task's sticky one for that provider; a usage limit blocks it, drops the provider's
   * session (another login cannot resume it; the stage handlers pick up from disk), and the
   * same prompt goes again on the next account. When that provider is exhausted, try the other
   * provider with its own model and session. With neither usable, check again every 30 seconds.
   */
  let feature: ShipFeature = task.feature;
  let pendingUser: string | undefined;
  let idle = 0;
  const crashes = new Map<string, number>(); // consecutive failed turns per account
  const turn = async (prompt: string | ((provider: Provider) => string), provider: Provider = builderProvider, model = builderModel, resume = true, timeoutMs?: number): Promise<string> => {
    for (let attempt = 0; attempt < 12;) {
      const live = loadState();
      const cur = live.tasks.find((t) => t.id === taskId)!;
      const who = pickTurnAccount(live.accounts, provider, Date.now(), cur.accountIds);
      if (!who) {
        const resets = (["claude", "codex"] as const).map((p) => earliestUnblock(live.accounts, p, Date.now())).filter((t): t is number => t !== undefined);
        const until = resets.length ? Math.min(...resets) : Date.now() + DEFAULT_BLOCK_MS;
        const waiting = `all accounts at their limit until ${resetLabel(until)}`;
        updateTask(taskId, { status: "waiting", note: waiting, activity: waiting });
        await notifyTask(taskId, "paused", waiting);
        await new Promise((r) => setTimeout(r, Math.min(30_000, Math.max(1_000, until - Date.now()))));
        continue;
      }
      const usage = await readUsage(who);
      const blocked = usageBlock(usage, Date.now());
      if (blocked) { blockAccount(who.id, blocked.until, blocked.reason); continue; }
      await notifyTask(taskId, "running", `Continuing on ${who.provider} (${who.name}).`);
      updateTask(taskId, { status: "working", note: undefined });
      attempt++;
      if (who.provider !== provider) {
        log(task, `No usable ${provider} account; continuing on ${who.provider} (${who.name})`);
        provider = who.provider;
        model = modelTiers(provider, models[provider]).orchestrator;
      }
      updateTask(task.id, (t) => ({ activeProvider: provider, accountIds: { ...t.accountIds, [provider]: who.id }, activity: `${turnTag}running ${provider} on ${who.name}` }));
      touchAccount(who.id);
      const session = resume && cur.accountIds[provider] === who.id ? cur.sessions[provider] : undefined;
      let usageLimit: ReturnType<typeof usageBlock>;
      let checking = false;
      let active = true;
      const usageTimer = setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          await flushTaskNotifications(taskId);
          const block = usageBlock(await readUsage(who), Date.now());
          if (!active) return;
          usageLimit = block;
          if (usageLimit) { blockAccount(who.id, usageLimit.until, usageLimit.reason); stopAgents(); }
        } catch (e) { log(task, `usage check failed: ${String(e)}`); }
        finally { checking = false; }
      }, 60_000);
      let timedOut = false;
      const deadline = timeoutMs ? setTimeout(() => { timedOut = true; stopAgents(); }, timeoutMs) : undefined;
      let res;
      try { res = await runTurn({ cwd: task.worktree, prompt: `${HEADLESS_RULES}\n\n${typeof prompt === "function" ? prompt(provider) : prompt}\n\n${ENVIRONMENT_RULES(env)}`, model, account: who, resume: session, env, onText: (t) => { const line = t.replace(/\s+/g, " ").trim(); log(task, `agent: ${line.slice(0, 200)}`); if (line) activity(`${turnTag}${line.slice(0, 160)}`); } }); }
      finally { active = false; clearInterval(usageTimer); if (deadline) clearTimeout(deadline); }
      if (timedOut) throw new Error("Evidence attempt exceeded 15 minutes; stopped the agent so the owner can help.");
      if (usageLimit) res.limit = { text: usageLimit.reason, resetsAt: usageLimit.until };
      if (res.limit) {
        blockAccount(who.id, res.limit.resetsAt, res.limit.text);
        updateTask(task.id, (t) => ({ sessions: { ...t.sessions, [provider]: undefined } }));
        log(task, `${who.name} hit its ${describeLimit(res.limit)}${res.limit.resetsAt ? ` (resets ${resetLabel(res.limit.resetsAt)})` : ""}; moving to another ${provider} account.`);
        continue;
      }
      if (res.sessionId && resume) updateTask(task.id, (t) => ({ sessions: { ...t.sessions, [provider]: res.sessionId } }));
      if (res.error) {
        crashes.set(who.id, (crashes.get(who.id) ?? 0) + 1);
        const n = crashes.get(who.id)!;
        log(task, `${provider} turn failed on ${who.name} (${n}): ${res.error}`);
        if (n >= 2) {
          // two crashes in a row on one account: park it for a while (a limit the CLI did not name, most likely) and use another
          blockAccount(who.id, Date.now() + 15 * 60_000, `crashed twice: ${res.error.slice(0, 80)}`);
          updateTask(task.id, (t) => ({ sessions: { ...t.sessions, [provider]: undefined } }));
          crashes.delete(who.id);
          log(task, `${who.name} failed twice (${res.error.split(":")[0]}); parking it for 15 minutes and continuing on another ${provider} account.`);
          continue;
        }
        activity(`turn failed, retrying in 20s: ${res.error.slice(0, 100)}`);
        await new Promise((r) => setTimeout(r, 20_000));
        continue;
      }
      crashes.delete(who.id);
      return res.text;
    }
    throw new Error(`gave up after repeated failures on ${provider}`);
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

  const completeReply = async (text: string, timeoutMs?: number) => {
    await applyReply(text);
    while (pendingUser) {
      const prompt = pendingUser;
      pendingUser = undefined;
      await applyReply(await turn(prompt, builderProvider, builderModel, true, timeoutMs));
    }
  };
  if (task.recoveryGuidance) {
    await completeReply(await turn(`The owner gave recovery guidance on Slack: ${task.recoveryGuidance}\nApply it and continue from the saved task state. Never merge.`));
    updateTask(taskId, { recoveryGuidance: undefined });
  }
  if (task.pendingQuestion) {
    const answer = await ask(task.pendingQuestion.questions);
    await completeReply(await turn(`The owner answered on Slack:\n${answer}\nContinue from where you stopped.`));
  }

  // ── the environment: what running this repo takes, on this task's ports ────────────────
  if (!task.envReadyAt) {
    activity("setting up the local environment");
    const text = await turn(ENVIRONMENT_PROMPT(env));
    await completeReply(text);
    updateTask(task.id, { envReadyAt: Date.now() });
    await say(`Local environment ready on ports ${env.CONSORT_PORT_RANGE}: ${stripAskUser(stripShipMarkers(text)).split("\n").find((l) => l.trim()) ?? ""}`.slice(0, 400));
  }

  // ── the stages, Grilling through In Review ──────────────────────────────────────────────
  for (let n = 0; feature.stage !== "In Review" && feature.stage !== "Merged" && feature.stage !== "Closed"; n++) {
    const form = feature.stage === "Ready to Test" ? "approve" as const : "resume" as const;
    const prompt = pendingUser ?? shipPrompt({ feature, form: { form }, worktree: task.worktree, branch: task.branch, base: `origin/${job.base}`, ticketBody, headless: true });
    pendingUser = undefined;
    turnTag = `t${n + 1} · `; activity(`${turnTag}starting`);
    const text = await turn(prompt);
    log(task, `turn ${n + 1} at ${feature.stage}: ${stripAskUser(stripShipMarkers(text)).slice(0, 300).replace(/\n/g, " ")}`);
    await applyReply(text);
    if (idle >= STUCK_AFTER) {
      const answer = await ask([`I have taken ${idle} turns at ${feature.stage} without moving. Last reply: "${stripShipMarkers(text).slice(0, 400)}". What should I do?`]);
      pendingUser = `The owner says: ${answer}`;
      idle = 0;
    }
  }
  if (feature.stage !== "In Review") { await finish("done", `PR was ${feature.stage.toLowerCase()} outside Consort`); return; }
  const prUrl = feature.prs.at(-1);
  const pr = prUrl ? prNumberFromUrl(prUrl) : undefined;
  if (!pr) { await finish("failed", "In Review without a PR"); await say(slackLines.stuck("the feature reached In Review without a PR")); return; }

  // ── three review rounds on rotating models, each followed by a fix turn ───────────────────
  for (let round = task.reviewsDone + 1; round <= rotation.length; round++) {
    const pick = rotation[round - 1];
    const provider: Provider = have[pick.provider] ? pick.provider : builderProvider;
    const model = have[pick.provider] ? pick.model : builderModel;
    log(task, `review round ${round} on ${provider}:${model}`);
    activity(`review round ${round} on ${model}`);
    rmSync(join(task.worktree, ".consort", "pr-review", `pr-${pr}.review.json`), { force: true });
    const reviewText = await turn((active) => reviewSkillPrompt(task.worktree, pr, modelTiers(active, models[active]).delegate), provider, model, false);
    await completeReply(reviewText);
    const summary = reviewSummaryOf(pr);
    if (!summary) throw new Error(`Review round ${round} did not write a valid review report`);
    await say(slackLines.review(round, model, summary.total));
    feature = { ...feature, review: { chatId: `cli-${round}`, pr, round, startedAt: Date.now(), doneAt: Date.now() }, reviewRound: round };
    updateTask(task.id, { feature });
    if (summary.total === 0) { updateTask(task.id, { reviewsDone: round }); continue; }
    activity(`fixing round ${round} findings (${summary.total})`);
    const fix = await turn(shipPrompt({ feature, form: { form: "pr-loop" }, worktree: task.worktree, branch: task.branch, base: `origin/${job.base}`, review: { running: false, summary }, headless: true }));
    await completeReply(fix);
    updateTask(task.id, { reviewsDone: round });
  }

  // ── evidence: prove it works, post the proof on the PR and the ticket, cross-linked ──────
  if (!feature.evidenceAt || !task.evidenceValidatedAt) {
    // Legacy evidence timestamps also counted failed captures; require the new validation gate.
    feature = { ...feature, evidenceAt: undefined };
    updateTask(taskId, { feature, evidenceValidatedAt: undefined });
    let guidance = "";
    for (;;) {
      activity("gathering evidence");
      let blocked: string;
      try {
        const browser = await findBrowser();
        const helper = browser ? writeScreenshotHelper(task.worktree, browser) : undefined;
        const prompt = EVIDENCE_PROMPT({ helper: helper ?? "(no browser installed: backend output may be text; frontend screenshots require a browser)", ticketUrl: task.ticket.url, prUrl: prUrl!, worktree: task.worktree, repoRoot: job.repo });
        const text = await turn(`${prompt}\n\n${guidance}`, builderProvider, builderModel, true, 15 * 60_000);
        await completeReply(text, 15 * 60_000);
        validateEvidence(task.worktree);
        activity("checking evidence against acceptance criteria");
        const verification = await turn(VERIFY_EVIDENCE_PROMPT, builderProvider, builderModel, false, 15 * 60_000);
        if (verification.trim() !== "[evidence-approved]") throw new Error(`Evidence inspection did not pass: ${stripAskUser(verification) || parseAskUser(verification).join(" ") || "No approval was returned."}`);
        const published = await publishEvidence({ worktree: task.worktree, repo: job.repo, ticket: task.ticket, pr, prUrl: prUrl!, source, clickupKey: state.clickupKey });
        if (!published?.items || !published.prComment || !published.ticketComment) throw new Error("Working evidence was not published to both the PR and ticket.");
        const at = Date.now();
        feature = { ...feature, evidenceAt: at };
        updateTask(taskId, { feature, evidenceValidatedAt: at });
        await say(`Verified evidence posted: ${published.items} items, ${published.images} images, on the PR and the ticket.`);
        break;
      } catch (e) {
        blocked = (e as Error).message;
        log(task, `Evidence blocked: ${blocked}`);
      }
      const answer = await ask([`Evidence is blocked and I will not hand off this PR: ${blocked.slice(0, 1500)}. What should I do to get the feature working? If a credential is missing, add the named variable to the repository-root env file on the Consort machine (${job.repo}/.env, or the repo's documented root env file), then confirm here. Do not send secret values in Slack.`]);
      guidance = `The previous evidence attempt failed: ${blocked}\nThe owner answered on Slack: ${answer}\nApply the answer, rerun the feature, and replace failed captures with working proof. The answer does not waive acceptance checks. Copy only specifically needed env variables from the root env file after the owner confirms they are ready; never expose their values.`;
    }
  }

  // ── reviewers, then the watch ─────────────────────────────────────────────────────────────
  const beforeReview = await readPr(job.repo, pr);
  if (beforeReview.isDraft) await run("gh", ["pr", "ready", String(pr)], { cwd: job.repo, timeout: 60_000 });
  const me = await whoAmI(job.repo);
  let requested = loadState().tasks.find((t) => t.id === taskId)?.reviewersRequested;
  let requestError: string | undefined;
  const excludedReviewers = [me, beforeReview.author ?? ""].filter(Boolean);
  while (!requested || requested.length < 2) {
    const suggested = await reviewerSuggestions(task.worktree, `origin/${job.base}`, excludedReviewers).catch((e) => { requestError = `Contributor lookup failed: ${(e as Error).message}`; return []; });
    const candidates = [...new Set(suggested)].filter((n) => !excludedReviewers.some((login) => login.toLowerCase() === n.toLowerCase()) && /^[A-Za-z0-9-]+$/.test(n));
    const names = candidates.length === 2 && !requestError ? candidates : (await ask([`Which two GitHub reviewers should I request? Reply with two GitHub logins. ${requestError ?? "GitHub contributors did not identify two eligible reviewers."}`])).split(/[\s,]+/).map((n) => n.replace(/^@/, "")).filter(Boolean);
    const unique = [...new Set(names)].filter((n) => !excludedReviewers.some((login) => login.toLowerCase() === n.toLowerCase()) && /^[A-Za-z0-9-]+$/.test(n));
    if (unique.length !== 2) { requestError = "I need exactly two distinct GitHub logins, excluding the PR author."; continue; }
    if (candidates.length === 2 && !requestError) await say(`Suggested reviewers from repository contributors: ${candidates.map((n) => `@${n}`).join(", ")}; prioritizing contributors to the changed files.`);
    try { await requestReviewers(job.repo, pr, unique); }
    catch (e) { requestError = `GitHub rejected the review request: ${(e as Error).message}`; continue; }
    requested = unique;
    updateTask(taskId, { reviewersRequested: requested });
    await say(slackLines.reviewers(requested));
  }
  updateTask(task.id, { status: "monitoring", activity: "watching the PR" });
  await notifyTask(taskId, "paused", "Waiting for human PR reviews or CI; checking every 3 minutes.");
  await say(`Watching the PR every ${PR_POLL_MS / 60_000} minutes: I will answer review comments and tell you when it is ready to merge.`);

  let recoveryGuidance: string | undefined;
  for (;;) {
    const state = await readPr(job.repo, pr).catch((e) => { log(task, `pr read failed: ${e.message}`); return undefined; });
    updateTask(task.id, { lastPrCheckAt: Date.now() });
    if (state) {
      try {
      if (recoveryGuidance) {
        await completeReply(await turn(recoveryGuidance));
        recoveryGuidance = undefined;
        continue;
      }
      if (state.state !== "OPEN") { await tell(`The PR is ${state.state.toLowerCase()}. Done here.`); await finish("done", `PR ${state.state.toLowerCase()}`); if (state.state === "MERGED") await source.setStatus(task.ticket.id, "done").catch(() => {}); return; }
      const seen = new Set(loadState().tasks.find((t) => t.id === taskId)?.threadsSeen ?? []);
      const fresh = [...state.unresolved, ...(state.feedback ?? [])].filter((t) => (!!t.threadId || !seen.has(t.id)) && t.author && t.author !== me && !/\[bot\]$/.test(t.author));
      const currentTask = loadState().tasks.find((t) => t.id === taskId)!;
      const observed = observeReviewBatch(currentTask.reviewBatch, fresh, Date.now());
      const previousBatch = currentTask.reviewBatch?.fingerprint;
      updateTask(taskId, { reviewBatch: observed.batch });
      if (fresh.length && !observed.ready) {
        const note = `collecting ${fresh.length} review comments; waiting for 3 quiet minutes`;
        updateTask(taskId, { status: "monitoring", activity: note });
        if (previousBatch !== observed.batch?.fingerprint) statusEvent("info", `Ticket ${task.ticket.id}: ${note}`);
        await notifyTask(taskId, "paused", "Collecting human review comments into a batch; waiting for three minutes without changes.");
        await new Promise((r) => setTimeout(r, PR_POLL_MS));
        continue;
      }
      if (fresh.length) {
        log(task, `${fresh.length} new review thread(s)`);
        activity(`answering ${fresh.length} review thread${fresh.length === 1 ? "" : "s"}`);
        const text = await turn(RESPOND_TO_REVIEW(fresh));
        await completeReply(text);
        const afterFix = await readPr(job.repo, pr);
        const remaining = new Set(afterFix.unresolved.map((t) => t.threadId).filter(Boolean));
        const addressed = fresh.filter((t) => !t.threadId || !remaining.has(t.threadId));
        updateTask(task.id, (t) => ({ threadsSeen: [...t.threadsSeen, ...addressed.map((f) => f.id)], reviewBatch: undefined }));
        await requestReviewers(job.repo, pr, requested);
        statusEvent("success", `Ticket ${task.ticket.id}: handled a batch of ${fresh.length} review comments`);
        await say(`Handled ${fresh.length} review comments as a batch; ${fresh.length - addressed.length} threads still unresolved and will be checked again.`);
        continue; // re-read straight away
      }
      if (state.ci === "fail") {
        const answer = await turn(`PR ${prUrl} has failing CI. Read gh pr checks and the failed job logs, fix the failures in this branch, run relevant checks, commit and push. If a failure needs a business or design decision, ask the owner. Never merge.`);
        await completeReply(answer);
        await notifyTask(taskId, "paused", "Waiting for CI after the repair; checking every 3 minutes.");
        updateTask(taskId, { status: "monitoring" });
        await new Promise((r) => setTimeout(r, PR_POLL_MS));
        continue;
      }
      const ready = prReadiness(state, [me], requested);
      if (ready.ready) {
        await tell(slackLines.ready(state.url));
        await finish("ready", "ready to merge");
        return;
      }
      log(task, `not ready: ${ready.reasons.join(", ")}`);
      updateTask(taskId, { status: "monitoring", activity: `watching PR: ${ready.reasons.join(", ")}` });
      await notifyTask(taskId, "paused", "Waiting for human PR reviews or CI; checking every 3 minutes.");
      } catch (e) {
        log(task, `Review loop needs help: ${(e as Error).message}`);
        const answer = await ask([`I could not continue the PR review/CI loop: ${(e as Error).message.slice(0, 1200)}. What should I do? I will keep this task open until both requested reviewers approve and CI passes.`]);
        recoveryGuidance = `The owner answered on Slack: ${answer}\nRecover the PR review/CI loop using this guidance. Fix and push what is needed; never merge.`;
      }
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
