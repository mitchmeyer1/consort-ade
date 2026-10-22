import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyShipChange, newShipFeature, parseShipMarkers, prNumberFromUrl, shipBranch, shipFolder, shipSlug, stripShipMarkers, type ShipFeature, type ShipTicket } from "../shared/ship.ts";
import { shipPrompt } from "../shared/shipPrompt.ts";
import { addTurnCost, blockerBullets, brief, costLine, evidenceApproved, shortUsd, DEFAULT_BLOCK_MS, earliestUnblock, ENVIRONMENT_PROMPT, ENVIRONMENT_RULES, HEADLESS_RULES, EVIDENCE_PROMPT, VERIFY_EVIDENCE_PROMPT, parseAskUser, parseReviewerReply, observeReviewBatch, pickAccount, prReadiness, ProblemError, problemOf, REBOOT_PROMPT, RESPOND_TO_REVIEW, REVIEW_QUIET_MS, cliReviewRotation, reviewersWithoutApproval, reviewWaitMessage, seedModels, slackLines, slackMessage, slackStatus, stripAskUser, type Problem } from "../shared/headless.ts";
import { describeLimit, resetLabel } from "../shared/seatPool.ts";
import { parseReview, reviewSummary, type ReviewSummary } from "../shared/review.ts";
import { selectCliModel, type CliModelRole } from "../shared/cliModels.ts";
import { MODEL_ROLE_RULES, parseModelEscalation, stageModelRole } from "../shared/cliTurnPolicy.ts";
import { AccountUnavailableError, withAgentTurn, withEnvironmentSlot } from "./capacity";
import { prepareResearchTasks, readImplementationTasks, recoverImplementation, runImplementation, runResearch, type ParallelRun } from "./parallel";
import { excludeConsortDir, fetchTicket, writeTicketFile } from "../main/ship";
import { addWorktree } from "../main/git";
import type { Provider } from "../shared/types";
import { runTurn, packageRoot } from "./agent";
import { readPr, requestReviewers, reviewerSuggestions, validateReviewers, whoAmI } from "./prmonitor";
import { findBrowser, publishEvidence, validateEvidence, writeScreenshotHelper } from "./evidence";
import { allocateEnvironment, cleanupEnvironment, withChildEnvironment } from "./environment";
import { flushTaskNotifications, notifyTask } from "./lifecycle";
import { readUsage, saveUsage, usageFor } from "./usage";
import { checkpoint } from "./checkpoint";
import { environmentPrompt, saveRepoEnv } from "./repoEnv";
import { graphSummary, planWaves, readGraph, RESPLIT_PROMPT, tooSerial } from "./buildGraph";
import { LINK_PROMPT, needsLinks, syncSubtaskProgress, writeSubtaskFile, type SubtaskState } from "./subtasks";
import type { Subtask } from "./sources";
import { draftBody, draftTitle, ensureDraftPr, updateDraftBody } from "./draftPr";
import { stepLabel } from "./buildProgress";
import type { TaskEnv } from "../shared/headless.ts";
import { modelBlock, modelLoad, usageBlock } from "../shared/usage.ts";
import { statusEvent } from "./statusLog";
import { Slack } from "./slack";
import { ensureSlackIdentity } from "./slackIdentity";
import { taskSlackLinks } from "./slackLinks";
import { ownerUpdatePrompt, parseUpdateSummary, updateDir } from "./ownerUpdates";
import { sourceFor, type Source } from "./sources";
import { blockAccount, loadState, processAlive, touchAccount, updateTask, WORK_DIR, type Account, type Job, type Task } from "./state";

/**
 * One ticket, start to ready-to-merge, with nobody watching: the /ship stages in a worktree of
 * their own, questions relayed over Slack, one review per configured provider, then a watch
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
  const modelFor = (provider: Provider, role: CliModelRole) => selectCliModel(provider, models[provider], role, job.modelPolicy);
  const builderModel = modelFor(builderProvider, "planning");
  const workerModel = modelFor(builderProvider, "implementation");
  const rotation = cliReviewRotation({ claude: have.claude ? models.claude : undefined, codex: have.codex ? models.codex : undefined }, job.reviewModels);

  updateTask(task.id, { pid: process.pid, activity: "starting" });
  task = loadState().tasks.find((t) => t.id === taskId)!;
  const activity = (line: string) => { updateTask(taskId, { activity: line }); };
  let turnTag = ""; // "t3 · " while a build turn runs, so the live line shows which turn it came from
  // the agent's last few progress lines from the current turn: what it was doing when something stopped it
  const recent: string[] = [];
  const noteProgress = (line: string) => { recent.push(line.slice(0, 200)); if (recent.length > 6) recent.shift(); updateTask(taskId, { activity: `${turnTag}${line.slice(0, 160)}`, recent: [...recent] }); void working(line); };
  // a short "Working: …" note in the thread while a turn runs: the first agent line right after the owner's answer, then at most one every WORKING_NOTE_MS
  const WORKING_NOTE_MS = 5 * 60_000;
  let lastWorkingAt = 0;
  const working = async (line: string) => {
    const clean = stripAskUser(stripShipMarkers(line)).replace(/\[evidence-approved\]/g, "").trim();
    if (!clean || !slack || !thread || Date.now() - lastWorkingAt < WORKING_NOTE_MS) return;
    lastWorkingAt = Date.now();
    await say(slackLines.working(clean));
  };
  // the task's own ports and Docker names, on every turn from here on
  const env = await withEnvironmentSlot(taskId, () => allocateEnvironment(task!));
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
  let ticketBody = writeTicketFile(task.worktree, task.ticket, fetched);
  // the ClickUp subtasks, so the build tickets can name them and the worker can move them (cli/subtasks.ts)
  const claimed = task!;
  const subtasks = await source.subtasks(claimed.ticket.id).catch((e) => { log(claimed, `subtasks not read: ${(e as Error).message}`); return [] as Subtask[]; });
  if (subtasks.length) writeSubtaskFile(claimed.worktree, subtasks);
  const syncSubtaskStatus = async (force?: SubtaskState) => {
    if (!subtasks.length) return;
    const tickets = await readGraph(claimed.worktree).catch(() => []);
    const head = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: claimed.worktree }).then((r) => r.stdout.trim()).catch(() => "");
    const where = [head && `Commit ${head} on ${claimed.branch}.`, feature.prs[0] && `PR: ${feature.prs[0]}`].filter(Boolean).join(" ");
    const current = loadState().tasks.find((t) => t.id === taskId);
    const saved = current?.subtaskSync ?? {};
    const { states, noted } = await syncSubtaskProgress({ source, parentId: claimed.ticket.id, subtasks, tickets, saved, noted: current?.subtaskTicketsNoted, where, force, log: (l) => log(claimed, l) });
    if (JSON.stringify(states) !== JSON.stringify(saved) || JSON.stringify(noted) !== JSON.stringify(current?.subtaskTicketsNoted)) updateTask(taskId, { subtaskSync: states, subtaskTicketsNoted: noted });
  };

  await ensureSlackIdentity(taskId);
  task = loadState().tasks.find(t => t.id === taskId)!;

  // one Slack thread per task
  let thread = task.slackThread;
  if (slack && !thread) {
    thread = await slack.post(slackStatus(slackLines.claimed(task.ticket.title, task.ticket.url, task.branch), "RUNNING", await taskSlackLinks(task, job.repo)));
    updateTask(task.id, { slackThread: thread });
  }
  const say = async (text: string) => { log(task, text.replace(/\n/g, " ⏎ ")); if (slack && thread) await slack.post(slackStatus(text, text.trimStart().startsWith("🎉🍭🎊") ? "COMPLETED" : loadState().tasks.find((t) => t.id === taskId)?.lifecycle === "paused" ? "WAITING" : "RUNNING", await taskSlackLinks(loadState().tasks.find((t) => t.id === taskId)!, job.repo)), thread).catch((e) => log(task, `slack failed: ${e.message}`)); };
  if (!task.pendingQuestion && task.status !== "monitoring" && task.lifecycle !== "paused") await notifyTask(taskId, "running", "Worker started; preparing the task.");
  const finish = async (status: Task["status"], note?: string) => {
    updateTask(task.id, { status, note, finishedAt: Date.now(), activity: note ?? status });
    await notifyTask(taskId, status === "ready" ? "completed" : "stopped", note ?? status);
    await cleanupEnvironment(env.CONSORT_RUN).then((r) => { if (r.containers || r.networks || r.volumes) log(task, `removed ${r.containers} container(s), ${r.networks} network(s), ${r.volumes} volume(s)`); });
    updateTask(taskId, { portBase: undefined, envReadyAt: undefined });
  };
  const tell = async (text: string) => { await say(text); await source.comment(task.ticket.id, text.replace(/<([^|>]+)\|([^>]+)>/g, "$2 ($1)")).catch((e) => log(task, `ticket comment failed: ${e.message}`)); };

  /** ask the owner on Slack and wait; without Slack the question is logged and the run stops */
  const ask = async (questions: string[], preformatted = false): Promise<string> => {
    updateTask(task.id, { status: "waiting", note: questions.join(" | "), activity: `waiting on Slack: ${questions[0].slice(0, 80)}` });
    if (!slack || !thread) throw new Error(`Needs the owner but Slack is not configured. Questions: ${questions.join(" | ")}`);
    const pending = loadState().tasks.find((t) => t.id === taskId)?.pendingQuestion;
    const ts = pending?.afterTs ?? await slack.post(slackStatus(slackMessage("waiting", preformatted ? questions[0] : slackLines.question(questions, task.ticket.url)), "WAITING", await taskSlackLinks(loadState().tasks.find((t) => t.id === taskId)!, job.repo)), thread);
    updateTask(taskId, { pendingQuestion: { questions, afterTs: ts } });
    // the pause reason carries the question itself: it shows in the Paused line, in status replies, and in the view
    await notifyTask(taskId, "paused", `Waiting on you: ${brief(questions[0].split("\n").filter((l) => l.trim()).map((l) => l.replace(/^(?:❌|✅|⏳|❓|⏹️|🎉🍭🎊)?\s*[•\-\d.\s]*/u, "").replace(/\s*\(<[^>]*\|ticket>\)/, "").replace(/[*_`]/g, "")).join(" · "), 300)}`);
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
    await notifyTask(taskId, "running", "Answer received.");
    lastWorkingAt = 0; // the first agent line after an answer posts right away, so the owner sees it is on it
    return reply ?? "";
  };

  /**
   * One agent turn on a provider, with the ship markers applied to the feature. The account is
   * the task's sticky one for that provider; a usage limit blocks it, drops the provider's
   * session (another login cannot resume it; the stage handlers pick up from disk), and the
   * same prompt goes again on the next account. When that provider is exhausted, try the other
   * provider with its own model and session. With neither usable, check again every 30 seconds.
   */
  // turns this worker has handed an account but not finished, so parallel tickets picking at once spread out
  const mine = new Map<string, number>();
  let feature: ShipFeature = task.feature;
  let pendingUser: string | undefined;
  let idle = 0;
  const turn = async (prompt: string | ((provider: Provider) => string), provider: Provider = builderProvider, role: CliModelRole = "planning", resume = true, timeoutMs?: number, cwd = task.worktree, fixedModel?: string, turnEnv: TaskEnv = env): Promise<string> => {
    const crashes = new Map<string, number>(); // failures in unrelated parallel jobs never combine
    // accounts that errored on this turn: the next attempt goes to a different account, on either provider
    const tried = new Set<string>();
    let lastCrash: string | undefined;
    let failedTurns = 0;
    let model = fixedModel ?? modelFor(provider, role);
    const readOnly = role === "reader";
    const managesSession = cwd === task.worktree && !fixedModel && !readOnly;
    let roleFailures = 0;
    let escalationReason: string | undefined;
    const ordinaryRole = role;
    const escalate = (reason: string) => {
      role = "frontier";
      model = modelFor(provider, role);
      escalationReason = reason;
      roleFailures = 0;
      resume = false;
      log(task, `escalating ${ordinaryRole} to ${model}: ${reason}`);
    };
    for (let attempt = 0; attempt < 12;) {
      const live = loadState();
      const cur = live.tasks.find((t) => t.id === taskId)!;
      // a turn that resumes a session stays on that session's account; any new agent goes to the least-used account for its model
      const canResume = resume && managesSession && !!cur.sessions[provider] && !!cur.accountIds[provider];
      // Claude and Codex are interchangeable: a new agent goes to whichever account, on either provider, has the most room
      // for this kind of turn (Fable vs Astra for frontier work, Sonnet/Opus vs Sol otherwise)
      const reserve = (a: Account | undefined) => { if (a) mine.set(a.id, (mine.get(a.id) ?? 0) + 1); return a; };
      const pickAny = async (): Promise<Account | undefined> => {
        const now = Date.now();
        const providers: Provider[] = fixedModel ? [provider] : ["claude", "codex"];
        const open = live.accounts.filter((a) => providers.includes(a.provider) && !(a.blockedUntil && a.blockedUntil > now));
        // every account already failed once this turn: start over rather than report a usage limit that is not there
        if (open.length && open.every((a) => tried.has(a.id))) tried.clear();
        const usable = open.filter((a) => !tried.has(a.id));
        const sticky = canResume ? usable.find((a) => a.provider === provider && a.id === cur.accountIds[provider]) : undefined;
        if (sticky || usable.length <= 1) return reserve(sticky ?? usable[0]);
        const usage = await usageFor(usable);
        const modelOn = (a: Account) => (fixedModel && a.provider === provider ? fixedModel : modelFor(a.provider, role));
        // accounts already running as many turns as they allow would only queue; parallel tickets spread to the free ones
        const running = (id: string) => (mine.get(id) ?? 0) + loadState().tasks.flatMap((t) => t.activeTurns ?? []).filter((a) => a.accountId === id && a.pid !== process.pid && processAlive(a.pid)).reduce((n, a) => n + (a.units ?? 1), 0);
        const scored = usable.filter((a) => !modelBlock(usage.get(a.id), modelOn(a))).map((a) => ({ a, full: running(a.id) >= (a.maxActiveTurns ?? 2) ? 1 : 0, load: modelLoad(usage.get(a.id), modelOn(a)) ?? 1_000 }));
        const pick = scored.sort((x, y) => x.full - y.full || x.load - y.load || (x.a.lastUsedAt ?? 0) - (y.a.lastUsedAt ?? 0))[0]?.a ?? pickAccount(usable, provider, now);
        reserve(pick);
        log(task, `${role} turn on ${pick ? `${pick.name} (${modelOn(pick)})` : "none"}; use for this turn: ${scored.map((x) => `${x.a.name} ${modelOn(x.a)} ${x.load === 1_000 ? "?" : x.load}%`).join(", ")}`);
        return pick;
      };
      const who = await pickAny();
      if (!who) {
        const resets = (fixedModel ? [provider] : ["claude", "codex"] as const).map((p) => earliestUnblock(live.accounts, p, Date.now())).filter((t): t is number => t !== undefined);
        const until = resets.length ? Math.min(...resets) : Date.now() + DEFAULT_BLOCK_MS;
        const waiting = `All AI accounts reached their usage limit until ${resetLabel(until)}. Consort retries every 30s. Your action: none; work resumes when credits reset.`;
        updateTask(taskId, { status: "waiting", note: waiting, activity: waiting });
        await notifyTask(taskId, "monitoring", waiting);
        await new Promise((r) => setTimeout(r, Math.min(30_000, Math.max(1_000, until - Date.now()))));
        continue;
      }
      const usage = (await usageFor([who], 60_000)).get(who.id)!;
      const blocked = usageBlock(usage, Date.now());
      if (blocked) { mine.set(who.id, (mine.get(who.id) ?? 1) - 1); blockAccount(who.id, blocked.until, blocked.reason); continue; }
      await notifyTask(taskId, "running", `Continuing on ${who.provider} (${who.name}).`);
      updateTask(taskId, { status: "working", note: undefined });
      attempt++;
      if (who.provider !== provider) {
        log(task, `continuing ${role} on ${who.provider} (${who.name}): it has the most room`);
        provider = who.provider;
        model = modelFor(provider, role);
      }
      updateTask(task.id, (t) => ({ activeProvider: provider,
        ...(managesSession ? { accountIds: { ...t.accountIds, [provider]: who.id }, sessions: { ...t.sessions, [provider]: t.accountIds[provider] === who.id ? t.sessions[provider] : undefined } } : {}),
        activity: `${turnTag}running ${provider} ${model} on ${who.name}` }));
      touchAccount(who.id);
      const reviewUnits = fixedModel ? Math.min(2, job.maxParallel ?? 2, who.maxActiveTurns ?? 2, live.capacity?.maxActiveTurns ?? 4) : 1;
      const delegation = reviewUnits > 1 ? "You may run ONE foreground review reader at a time, on the supplied reader model. Never spawn nested agents or background agents. This overrides any larger wave in the skill." : "Do not dispatch agents. Consort has reserved only your turn; inspect the review evidence yourself. This overrides the skill's delegation instructions.";
      const session = resume && managesSession && cur.accountIds[provider] === who.id ? cur.sessions[provider] : undefined;
      const abort = new AbortController();
      let usageLimit: ReturnType<typeof usageBlock>;
      let checking = false;
      let active = true;
      const checkUsage = async () => {
        if (checking) return;
        checking = true;
        try {
          await flushTaskNotifications(taskId);
          const latest = await readUsage(who);
          saveUsage(new Map([[who.id, latest]]));
          const block = usageBlock(latest, Date.now());
          if (!active) return;
          usageLimit = block;
          if (usageLimit) { blockAccount(who.id, usageLimit.until, usageLimit.reason); abort.abort(); }
        } catch (e) { log(task, `usage check failed: ${String(e)}`); }
        finally { checking = false; }
      };
      let timedOut = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let usageTimer: ReturnType<typeof setInterval> | undefined;
      let res;
      recent.length = 0;
      let startedAt = Date.now();
      try { res = await withAgentTurn(taskId, who.id, () => {
        startedAt = Date.now();
        usageTimer = setInterval(checkUsage, 60_000);
        deadline = timeoutMs ? setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs) : undefined;
        return runTurn({ cwd, prompt: `${HEADLESS_RULES}\n\n${MODEL_ROLE_RULES(role)}\n\n${escalationReason ? `Previous attempt needs deeper analysis: ${escalationReason}. Read the saved task artifacts and continue.\n\n` : ""}${typeof prompt === "function" ? prompt(provider) : prompt}\n\n${ENVIRONMENT_RULES(turnEnv)}\n\n## Runtime delegation limit\n${delegation}`, model, account: who, resume: session, env: turnEnv, signal: abort.signal, readOnly, effort: role === "reader" ? "low" : role === "frontier" ? "high" : "medium", delegateModel: modelFor(provider, "reader"), maxDelegates: reviewUnits - 1, onText: (t) => { const line = t.replace(/\s+/g, " ").trim(); log(task, `agent: ${line.slice(0, 200)}`); if (line) noteProgress(line); } });
      }, reviewUnits); }
      catch (e) { if (e instanceof AccountUnavailableError) { continue; } throw e; }
      finally { active = false; mine.set(who.id, (mine.get(who.id) ?? 1) - 1); if (usageTimer) clearInterval(usageTimer); if (deadline) clearTimeout(deadline); }
      if (usageLimit) res.limit = { text: usageLimit.reason, resetsAt: usageLimit.until };
      updateTask(taskId, t => ({
        ...(res.usage?.length ? { cost: addTurnCost(t.cost, res.usage) } : {}),
        turnHistory: [...(t.turnHistory ?? []), { at: startedAt, stage: feature.stage, role, provider, model, durationMs: Date.now() - startedAt, usage: res.usage, error: timedOut ? `Timed out after ${timeoutMs}ms` : res.error ?? res.limit?.text, escalated: !!escalationReason, escalationReason }],
      }));
      if (timedOut) {
        const minutes = Math.round(timeoutMs! / 60_000);
        throw new ProblemError({ where: "", what: `The agent exceeded ${minutes} minutes on one turn and was stopped`, recent: [...recent], tried: recent.length ? undefined : `${minutes} minutes with no progress lines from the agent`, error: res?.error });
      }
      if (res.limit) {
        blockAccount(who.id, res.limit.resetsAt, res.limit.text);
        if (managesSession) updateTask(task.id, (t) => ({ sessions: { ...t.sessions, [provider]: undefined } }));
        log(task, `${who.name} hit its ${describeLimit(res.limit)}${res.limit.resetsAt ? ` (resets ${resetLabel(res.limit.resetsAt)})` : ""}; moving to another ${provider} account.`);
        continue;
      }
      if (res.sessionId && managesSession) updateTask(task.id, (t) => ({ sessions: { ...t.sessions, [provider]: res.sessionId } }));
      if (res.error) {
        tried.add(who.id);
        if (managesSession) updateTask(task.id, (t) => ({ sessions: { ...t.sessions, [provider]: undefined } }));
        const untried = live.accounts.some((a) => (fixedModel ? a.provider === provider : true) && !tried.has(a.id) && !(a.blockedUntil && a.blockedUntil > Date.now()));
        // a network error says nothing about the model: try another account now; when every one has failed, wait and start over
        if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|Can't reach the API|network error|fetch failed/i.test(res.error)) {
          lastCrash = `${who.name} (${provider} ${model}): ${res.error}`;
          failedTurns++;
          log(task, `${who.name} could not reach its API (${res.error.slice(0, 80)}); ${untried ? "trying another account" : "every account failed; retrying in 60s"}`);
          if (!untried) { tried.clear(); activity("AI APIs unreachable; retrying in 60s"); await new Promise((r) => setTimeout(r, 60_000)); }
          continue;
        }
        roleFailures++;
        if (roleFailures >= (job.maxModelAttempts ?? 2)) {
          if (role !== "frontier") { escalate(res.error); continue; }
          // the frontier model on one account failing is not the end: try it on every other account, Claude or Codex, first
          if (untried) { log(task, `frontier turn failed on ${who.name}; trying it on another account`); continue; }
          throw new ProblemError({ where: feature.stage, what: `The ${role} model failed on every account (${tried.size} tried)`, error: res.error });
        }
        crashes.set(who.id, (crashes.get(who.id) ?? 0) + 1);
        const n = crashes.get(who.id)!;
        lastCrash = `${who.name} (${provider} ${model}): ${res.error}`;
        failedTurns++;
        log(task, `${provider} turn failed on ${who.name} (${n}): ${res.error}`);
        if (n >= 2) {
          // two crashes in a row on one account: park it for a while (a limit the CLI did not name, most likely) and use another
          blockAccount(who.id, Date.now() + 15 * 60_000, `crashed twice: ${res.error.slice(0, 80)}`);
          if (managesSession) updateTask(task.id, (t) => ({ sessions: { ...t.sessions, [provider]: undefined } }));
          crashes.delete(who.id);
          log(task, `${who.name} failed twice (${res.error.split(":")[0]}); parking it for 15 minutes and continuing on another ${provider} account.`);
          continue;
        }
        activity(`turn failed, retrying in 20s: ${res.error.slice(0, 100)}`);
        await new Promise((r) => setTimeout(r, 20_000));
        continue;
      }
      crashes.delete(who.id);
      const requested = parseModelEscalation(res.text);
      if (requested && !parseAskUser(res.text).length) {
        if (role !== "frontier") { escalate(requested); continue; }
        throw new ProblemError({ where: feature.stage, what: "The frontier model could not resolve the task", why: [requested] });
      }
      return res.text;
    }
    throw new ProblemError({ where: "", what: `Gave up after ${failedTurns} failed agent turns on ${provider}`, recent: [...recent], tried: "each account twice, 20s apart; crashed accounts parked for 15 minutes", error: lastCrash });
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

  const completeReply = async (text: string, timeoutMs?: number, role: CliModelRole = "planning", provider: Provider = builderProvider, fixedModel?: string) => {
    await applyReply(text);
    while (pendingUser) {
      const prompt = pendingUser;
      pendingUser = undefined;
      await applyReply(await turn(prompt, provider, role, !fixedModel, timeoutMs, task.worktree, fixedModel));
    }
  };
  /**
   * Owner updates the daemon queued from the Slack thread (cli/ownerUpdates.ts): one agent turn
   * revises the ticket and the code, then the revised description and the files go to the ticket.
   */
  const applyOwnerUpdates = async (): Promise<boolean> => {
    const updates = loadState().tasks.find((t) => t.id === taskId)?.ownerUpdates ?? [];
    if (!updates.length) return false;
    const ticketFile = `${updateDir(updates.at(-1)!.ts)}/ticket.md`;
    mkdirSync(join(task.worktree, ticketFile, ".."), { recursive: true });
    rmSync(join(task.worktree, ticketFile), { force: true });
    activity(`applying ${updates.length} owner update${updates.length === 1 ? "" : "s"} from Slack`);
    const text = await turn(ownerUpdatePrompt(updates, { stage: feature.stage, built: !!feature.built, prUrl: feature.prs.at(-1), ticketFile }), builderProvider, "implementation");
    await completeReply(text, undefined, "implementation");
    const applied = new Set(updates.map((u) => u.ts));
    updateTask(taskId, (t) => ({ ownerUpdates: (t.ownerUpdates ?? []).filter((u) => !applied.has(u.ts)) }));
    const summary = parseUpdateSummary(text) ?? brief(stripAskUser(stripShipMarkers(text)), 200);
    const notes: string[] = [];
    let revised: string | undefined;
    try { revised = readFileSync(join(task.worktree, ticketFile), "utf8").trim(); } catch { notes.push("Ticket description unchanged: the agent wrote no revised ticket"); }
    if (revised && revised !== (ticketBody ?? "").trim()) {
      try {
        await source.updateBody(task.ticket.id, revised);
        ticketBody = writeTicketFile(task.worktree, task.ticket, await fetchTicket(task.ticket, { repoPath: job.repo, clickupKey: state.clickupKey }).catch(() => undefined) ?? { body: revised });
        notes.push("Ticket description updated");
      } catch (e) { notes.push(`Ticket description not updated: ${(e as Error).message}`); }
    } else if (revised) notes.push("Ticket description already matched");
    const files = updates.flatMap((u) => u.files);
    const attached: string[] = [];
    for (const file of files) {
      try { if (await source.attach(task.ticket.id, join(task.worktree, file))) attached.push(file); }
      catch (e) { notes.push(`Could not attach ${file.split("/").pop()}: ${(e as Error).message}`); }
    }
    const names = (list: string[]) => list.map((f) => f.split("/").pop()).join(", ");
    if (attached.length) notes.push(`Attached to the ticket: ${names(attached)}`);
    const comment = `Updated from Slack by the owner: ${summary}${files.length ? `\nFiles: ${names(files)}` : ""}`;
    await source.comment(task.ticket.id, comment).catch((e) => notes.push(`Ticket comment failed: ${(e as Error).message}`));
    await say(slackMessage("update", `Applied your update: ${summary}${notes.map((n) => `\n• ${n}`).join("")}`));
    return true;
  };
  // after each step before the PR: commit what the turn left uncommitted and push the branch, so progress is on GitHub too
  const progressLabel = () => {
    const step = stepLabel(feature.stage === "Implementing" ? "Build" : feature.stage, task.worktree);
    return `${feature.stage}${step.startsWith("Build ") ? ` (${step})` : ""}`;
  };
  // the draft PR, from the first step on, so the Slack github link shows the diff and a summary (cli/draftPr.ts)
  const draftOpen = () => !feature.built && !["In Review", "Merged", "Closed"].includes(feature.stage);
  const openDraft = async () => {
    if (feature.prs.length || !draftOpen()) return;
    const pr = await ensureDraftPr({ cwd: task.worktree, base: job.base, branch: task.branch, title: draftTitle(task.ticket), body: draftBody(task.ticket, progressLabel(), ticketBody) });
    if (!pr.url) { log(task, `draft PR not opened yet: ${pr.error}`); return; }
    feature = { ...feature, prs: [pr.url] };
    updateTask(task.id, { feature });
    await say(slackLines.pr(pr.url));
  };
  const saveProgress = async () => {
    const saved = await checkpoint(task.worktree, task.branch, `Consort checkpoint: ${progressLabel()}`);
    if (saved.error) log(task, `checkpoint failed: ${saved.error}`);
    else if (saved.committed || saved.pushed) log(task, `checkpoint${saved.committed ? " committed" : ""}${saved.pushed ? ` and pushed ${task.branch}` : ""}`);
    await syncSubtaskStatus();
    if (!feature.prs.length) await openDraft();
    else if (draftOpen() && !saved.error) {
      const failed = await updateDraftBody(task.worktree, feature.prs[0], draftBody(task.ticket, progressLabel(), ticketBody));
      if (failed) log(task, `draft PR description not updated: ${failed}`);
    }
  };
  // waits between PR checks end early when the owner posts an update
  const nap = (ms: number) => new Promise<void>((resolve) => {
    const check = setInterval(() => { if (loadState().tasks.find((t) => t.id === taskId)?.ownerUpdates?.length) done(); }, 15_000);
    const done = () => { clearInterval(check); resolve(); };
    setTimeout(done, ms);
  });

  log(task, `models: planning, spec and judgement on ${builderModel}; build and routine turns on ${workerModel}`);
  if (task.rebootedAt) {
    // `consort-cli reboot`: the owner stopped the last worker; open by working out where it got to
    log(task, "rebooted by the owner; picking up after the last run");
    await say(slackLines.rebooted(feature.stage));
    activity("rebooted: checking where the last run got to");
    await completeReply(await turn(REBOOT_PROMPT));
    updateTask(taskId, { rebootedAt: undefined });
  }
  if (task.recoveryGuidance) {
    await completeReply(await turn(`The owner gave recovery guidance on Slack: ${task.recoveryGuidance}\nApply it and continue from the saved task state. Never merge.`));
    updateTask(taskId, { recoveryGuidance: undefined });
  }
  if (task.pendingQuestion && task.pendingQuestion.questions.some((q) => /Evidence inspection did not pass:/.test(q) && evidenceApproved(q))) {
    // a false alarm from an earlier build: the verifier approved with prose around the marker and the strict check called it a failure
    log(task, "dropping a stale question: the evidence was approved");
    updateTask(taskId, { pendingQuestion: undefined, status: "working", note: undefined });
    task.pendingQuestion = undefined;
    await say("• Ignore the question above: the evidence was approved. Continuing");
  }
  if (task.pendingQuestion) {
    const answer = await ask(task.pendingQuestion.questions);
    await completeReply(await turn(`The owner answered on Slack:\n${answer}\nContinue from where you stopped.`));
  }

  // ── the environment: what running this repo takes, on this task's ports ────────────────
  if (!task.envReadyAt) {
    activity("setting up the local environment");
    // start from what an earlier task on this repo worked out, and keep this one's for the next (cli/repoEnv.ts)
    const text = await turn(environmentPrompt(job.repo, task.worktree, env), builderProvider, "implementation");
    await completeReply(text, undefined, "implementation");
    if (saveRepoEnv(job.repo, task.worktree)) log(task, "saved this repo's environment setup for the next task");
    updateTask(task.id, { envReadyAt: Date.now() });
    await say(slackLines.env(env.CONSORT_PORT_RANGE));
  }
  await applyOwnerUpdates();
  await openDraft();

  const parallelDirectory = join(task.worktree, ".consort", "ship", "parallel");
  const parallelRun: ParallelRun = async child => {
    // a parallel ticket gets 90 minutes (saved every 5, so a timeout resumes); research stays short
    const execute = async (childEnv: TaskEnv) => ({ text: await turn(child.prompt, builderProvider, child.kind === "research" ? "reader" : "implementation", false, child.kind === "research" ? 15 * 60_000 : 90 * 60_000, child.cwd, undefined, childEnv) });
    return child.kind === "implementation" ? withChildEnvironment(taskId, child.id, execute) : execute(env);
  };
  let sharedResearch = "";
  let parallelGuidance = "";

  // ── the stages, Grilling through In Review ──────────────────────────────────────────────
  for (let n = 0; feature.stage !== "In Review" && feature.stage !== "Merged" && feature.stage !== "Closed"; n++) {
    if (await applyOwnerUpdates()) continue;
    if (feature.stage === "Grilling") {
      activity("researching business flows, tests and integrations");
      try {
        const research = await runResearch({ cwd: task.worktree, directory: parallelDirectory, tasks: await prepareResearchTasks(task.worktree, ticketBody ?? task.ticket.title), concurrency: job.parallelResearch ?? 3, run: parallelRun });
        sharedResearch = research.summary;
        log(task, research.reused ? "reusing unchanged task research" : "parallel research complete");
      } catch (e) {
        // The coordinator can still do serial research, retaining any real owner questions.
        parallelGuidance = `Research collection needs follow-up: ${(e as Error).message}. Complete the missing research before the spec, and relay any owner decision with [ask-user: ...].`;
        log(task, parallelGuidance);
      }
    }
    if (["Spec'd", "Implementing"].includes(feature.stage) && !feature.built) {
      // the dependency graph, in code: post the waves when the ticket set changes; a graph that is mostly a chain gets one re-split
      const tickets = await readGraph(task.worktree).catch(() => []);
      const graph = planWaves(tickets);
      if (graph.remaining) {
        const ids = tickets.map((t) => t.id).join(",");
        const current = loadState().tasks.find((t) => t.id === taskId);
        // two tries to link the tickets to the ClickUp subtasks; the agent edits only the ticket files
        if (needsLinks(subtasks, tickets) && (current?.subtaskLinkTries ?? 0) < 2) {
          updateTask(taskId, { subtaskLinkTries: (current?.subtaskLinkTries ?? 0) + 1 });
          log(task, `linking ${tickets.length} build tickets to ${subtasks.length} ClickUp subtasks`);
          activity("linking build tickets to the ClickUp subtasks");
          await completeReply(await turn(LINK_PROMPT, builderProvider, "implementation"), undefined, "implementation");
          if (needsLinks(subtasks, await readGraph(task.worktree).catch(() => []))) log(task, "the link turn added no ClickUp lines");
          else await syncSubtaskStatus();
          continue;
        }
        const asked = !!current?.resplitRequested;
        if (asked || (tooSerial(graph) && !current?.graphResplitAt)) {
          updateTask(taskId, { graphResplitAt: Date.now(), resplitRequested: undefined });
          log(task, `${asked ? "owner asked to re-split the build" : "build graph is mostly a chain"} (${graphSummary(graph)}); re-splitting for parallel work`);
          activity("re-splitting the build into parallel tickets");
          if (asked) await say(slackMessage("update", `Re-splitting the remaining build for parallel work (${graphSummary(graph)} now)`));
          await completeReply(await turn(RESPLIT_PROMPT(graph, tickets, asked), builderProvider, "frontier"), undefined, "frontier");
          continue;
        }
        if (current?.buildPlanIds !== ids) {
          updateTask(taskId, { buildPlanIds: ids });
          await say(slackMessage("update", `Build plan: ${graphSummary(graph)}${graph.waves[0] ? `. Starting together: ${graph.waves[0].join(", ")}` : ""}${graph.problems.length ? `\n• ${graph.problems.slice(0, 3).join("\n• ")}` : ""}`));
        }
      }
      try {
        await recoverImplementation(task.worktree, parallelDirectory);
        const wave = await runImplementation({ cwd: task.worktree, directory: parallelDirectory, tasks: await readImplementationTasks(task.worktree), onStart: async (ids) => { log(task, `wave started: ${ids.join(", ")}`); await say(slackMessage("update", `Building ${ids.length} tickets in parallel: ${ids.join(", ")}`)); await syncSubtaskStatus(); }, concurrency: job.parallelImplementation ?? job.maxParallel ?? 4, run: parallelRun, check: async () => {
          const checked = await turn("The coordinator integrated parallel ticket commits. Read repository setup and each completed ticket. Run the relevant tests and typecheck together, fix any failures, and commit fixes. Do not push or move the ship stage. Return [parallel-check: pass] only after all required checks pass; include the commands and their results. If a real owner decision blocks verification, return [ask-user: ...].", builderProvider, "implementation", true, 45 * 60_000);
          if (!/\[parallel-check: pass\]/.test(checked) || parseAskUser(checked).length) throw new Error(checked || "Parallel implementation checks did not return passing proof");
        } });
        if (wave.completed.length) log(task, `integrated and checked ${wave.completed.join(", ")}`);
        if (wave.failed?.length) {
          log(task, `wave tickets to retry: ${wave.failed.map((f) => `${f.id} (${f.error})`).join("; ")}`);
          parallelGuidance = `These parallel tickets stopped before finishing and go back to ready; their work so far is saved and the next wave resumes from it: ${wave.failed.map((f) => `${f.id}: ${f.error}`).join("; ")}. Do not rebuild them yourself unless one cannot run in parallel.`;
        }
      } catch (e) {
        parallelGuidance = `Parallel implementation needs follow-up: ${(e as Error).message}. Read the journal and ticket status files. Repair integrated work and rerun checks; do not rebuild completed tickets. Relay owner questions before continuing.`;
        log(task, parallelGuidance);
      }
    }
    const form = feature.stage === "Ready to Test" ? "approve" as const : "resume" as const;
    const stagePrompt = pendingUser ?? shipPrompt({ feature, form: { form }, worktree: task.worktree, branch: task.branch, base: `origin/${job.base}`, ticketBody, headless: true, runtimeParallel: true });
    const prompt = `${stagePrompt}\n\n${sharedResearch ? `## Shared research (verify changed code before relying on it)\n${sharedResearch}\n` : ""}${parallelGuidance}`;
    pendingUser = undefined;
    parallelGuidance = "";
    // writing the build plan (no tickets yet) is the turn that decides how parallel the build can be: Fable or Astra
    const writesPlan = ["Spec'd", "Implementing"].includes(feature.stage) && !feature.built && !(await readGraph(task.worktree).catch(() => [])).length;
    const role = writesPlan ? "frontier" : stageModelRole(feature.stage, idle);
    turnTag = `t${n + 1} · `; activity(`${turnTag}starting`);
    const text = await turn(prompt, builderProvider, role);
    log(task, `turn ${n + 1} at ${feature.stage}: ${stripAskUser(stripShipMarkers(text)).slice(0, 300).replace(/\n/g, " ")}`);
    await applyReply(text);
    await saveProgress();
    if (idle >= STUCK_AFTER) {
      const answer = await ask([slackLines.problem({ where: feature.stage, what: `${idle} turns in a row did not move the stage`, why: [`Last reply: ${brief(stripAskUser(stripShipMarkers(text)), 300)}`], recent: [...recent], ask: "Reply with what to do next." }, task.ticket.url)], true);
      pendingUser = `The owner says: ${answer}`;
      idle = 0;
    }
  }
  if (feature.stage !== "In Review") { await finish("done", `PR was ${feature.stage.toLowerCase()} outside Consort`); return; }
  const prUrl = feature.prs.at(-1);
  const pr = prUrl ? prNumberFromUrl(prUrl) : undefined;
  if (!pr) { await finish("failed", "In Review without a PR"); await say(slackLines.stuck("the feature reached In Review without a PR")); return; }

  // ── one review per configured provider, each followed by a fix turn ───────────────────
  for (let round = task.reviewsDone + 1; round <= rotation.length; round++) {
    await applyOwnerUpdates();
    const pick = rotation[round - 1];
    const provider: Provider = have[pick.provider] ? pick.provider : builderProvider;
    const model = have[pick.provider] ? pick.model : builderModel;
    log(task, `review round ${round} on ${provider}:${model}`);
    activity(`review round ${round} on ${model}`);
    rmSync(join(task.worktree, ".consort", "pr-review", `pr-${pr}.review.json`), { force: true });
    const reviewText = await turn((active) => reviewSkillPrompt(task.worktree, pr, modelFor(active, "reader")), provider, "frontier", false, undefined, task.worktree, model);
    await completeReply(reviewText, undefined, "frontier", provider, model);
    const summary = reviewSummaryOf(pr);
    if (!summary) throw new Error(`Review round ${round} did not write a valid review report`);
    await say(slackLines.review(round, model, summary.total));
    feature = { ...feature, review: { chatId: `cli-${round}`, pr, round, startedAt: Date.now(), doneAt: Date.now() }, reviewRound: round };
    updateTask(task.id, { feature });
    if (summary.total === 0) { updateTask(task.id, { reviewsDone: round }); continue; }
    activity(`fixing round ${round} findings (${summary.total})`);
    const fix = await turn(shipPrompt({ feature, form: { form: "pr-loop" }, worktree: task.worktree, branch: task.branch, base: `origin/${job.base}`, review: { running: false, summary }, headless: true, runtimeParallel: true }), builderProvider, "implementation");
    await completeReply(fix, undefined, "implementation");
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
      let blocked: Problem;
      try {
        const browser = await findBrowser();
        const helper = browser ? writeScreenshotHelper(task.worktree, browser) : undefined;
        const prompt = EVIDENCE_PROMPT({ helper: helper ?? "(no browser installed: backend output may be text; frontend screenshots require a browser)", ticketUrl: task.ticket.url, prUrl: prUrl!, worktree: task.worktree, repoRoot: job.repo });
        const text = await turn(`${prompt}\n\n${guidance}`, builderProvider, "implementation", true, 15 * 60_000);
        await completeReply(text, 15 * 60_000, "implementation");
        validateEvidence(task.worktree);
        activity("checking evidence against acceptance criteria");
        const verification = await turn(VERIFY_EVIDENCE_PROMPT, builderProvider, "coordination", false, 15 * 60_000);
        if (!evidenceApproved(verification)) throw new ProblemError({ where: "evidence", what: "The evidence check did not pass", why: blockerBullets(stripAskUser(verification) || parseAskUser(verification).join(" ") || "No approval was returned.") });
        const cost = loadState().tasks.find((t) => t.id === taskId)?.cost;
        const published = await publishEvidence({ worktree: task.worktree, repo: job.repo, ticket: task.ticket, pr, prUrl: prUrl!, source, clickupKey: state.clickupKey, cost, timing: { startedAt: task.startedAt, endedAt: Date.now() } });
        if (!published?.items || !published.prComment || !published.ticketComment) throw new ProblemError({ where: "evidence", what: "Evidence was not published to both the PR and ticket", why: [`PR comment: ${published?.prComment ? "posted" : "missing"}`, `Ticket comment: ${published?.ticketComment ? "posted" : "missing"}`, `Items: ${published?.items ?? 0}`] });
        const at = Date.now();
        feature = { ...feature, evidenceAt: at };
        updateTask(taskId, { feature, evidenceValidatedAt: at });
        await say(slackLines.evidence(published.items, published.images, cost ? shortUsd(cost) : undefined));
        break;
      } catch (e) {
        // the validator and the publisher throw plain errors: their message is the reason, one sentence per bullet
        blocked = e instanceof ProblemError ? problemOf(e, "evidence", { recent: [...recent] }) : { where: "evidence", what: "Evidence was not accepted", why: blockerBullets((e as Error).message), recent: [...recent], ...(problemOf(e, "evidence").error ? { error: problemOf(e, "evidence").error } : {}) };
        blocked.lead ??= "Evidence blocked. PR not handed off";
        blocked.ask ??= `If a key is missing: add it to \`${job.repo}/.env\` on this machine, then reply "done". Otherwise say what to do. No secrets in Slack.`;
        log(task, `Evidence blocked: ${[blocked.what, ...(blocked.why ?? [])].join(" ")}`);
      }
      const answer = await ask([slackLines.problem(blocked, task.ticket.url)], true);
      guidance = `The previous evidence attempt failed: ${[blocked.what, ...(blocked.why ?? []), blocked.error ?? ""].join("\n")}\nThe owner answered on Slack: ${answer}\nApply the answer, rerun the feature, and replace failed captures with working proof. The answer does not waive acceptance checks. Use existing required root env variables without another approval when covered by the sub-dollar AI allowance. If a key was missing, copy only that named variable after the owner confirms it is ready; never expose secret values.`;
    }
  }

  // ── reviewers, then the watch ─────────────────────────────────────────────────────────────
  const beforeReview = await readPr(job.repo, pr);
  if (beforeReview.isDraft) await run("gh", ["pr", "ready", String(pr)], { cwd: job.repo, timeout: 60_000 });
  const me = await whoAmI(job.repo);
  let requested = loadState().tasks.find((t) => t.id === taskId)?.reviewersRequested;
  let requestError: string | undefined;
  if (requested?.length) {
    const valid = await validateReviewers(job.repo, requested);
    if (valid.length !== 2) {
      await say("✅ The saved reviewer names were not valid repository reviewers; selecting real contributors and verifying GitHub requests.");
      updateTask(taskId, { reviewersRequested: undefined });
      requested = undefined;
    } else requested = valid;
  }
  const excludedReviewers = [me, beforeReview.author ?? ""].filter(Boolean);
  while (!requested || requested.length < 2) {
    const suggested = await reviewerSuggestions(task.worktree, `origin/${job.base}`, excludedReviewers).catch((e) => { requestError = `Contributor lookup failed: ${(e as Error).message}`; return []; });
    const candidates = [...new Set(suggested)].filter((n) => !excludedReviewers.some((login) => login.toLowerCase() === n.toLowerCase()) && /^[A-Za-z0-9-]+$/.test(n));
    const names = candidates.length === 2 && !requestError ? candidates : parseReviewerReply(await ask([`Which two GitHub reviewers? Reply with @login1 @login2. ${requestError ?? "The changed files' contributors gave fewer than two."}`]));
    const unique = [...new Set(names)].filter((n) => !excludedReviewers.some((login) => login.toLowerCase() === n.toLowerCase()) && /^[A-Za-z0-9-]+$/.test(n));
    if (unique.length !== 2) { requestError = "I need exactly two distinct GitHub logins, excluding the PR author."; continue; }
    const verified = await validateReviewers(job.repo, unique);
    if (verified.length !== 2) { requestError = "Those logins do not identify two people with repository access. Use two @GitHub logins."; continue; }
    if (candidates.length === 2 && !requestError) await say(slackLines.reviewerPick(candidates));
    let sent: string[];
    try { sent = await requestReviewers(job.repo, pr, unique); }
    catch (e) { requestError = `GitHub rejected the review request: ${(e as Error).message}`; continue; }
    requested = verified;
    updateTask(taskId, { reviewersRequested: requested });
    if (sent.length) await say(slackLines.reviewers(sent));
  }
  updateTask(task.id, { status: "monitoring", activity: "watching the PR" });
  // Read GitHub first so the pause explains the real blockers.

  let recoveryGuidance: string | undefined;
  let conflictFixes = 0; // merge-conflict repairs pushed on this watch; after a few the owner is asked
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
      if (state.state === "OPEN" && await applyOwnerUpdates()) continue;
      if (state.state !== "OPEN") { await tell(slackLines.prClosed(state.state.toLowerCase())); await finish("done", `PR ${state.state.toLowerCase()}`); if (state.state === "MERGED") { await source.setStatus(task.ticket.id, "done").catch(() => {}); await syncSubtaskStatus("done").catch(() => {}); } return; }
      const seen = new Set(loadState().tasks.find((t) => t.id === taskId)?.threadsSeen ?? []);
      const fresh = [...state.unresolved, ...(state.feedback ?? [])].filter((t) => (!!t.threadId || !seen.has(t.id)) && t.author && t.author !== me && !/\[bot\]$/.test(t.author));
      const currentTask = loadState().tasks.find((t) => t.id === taskId)!;
      const observed = observeReviewBatch(currentTask.reviewBatch, fresh, Date.now());
      const previousBatch = currentTask.reviewBatch?.fingerprint;
      updateTask(taskId, { reviewBatch: observed.batch });
      if (fresh.length && !observed.ready) {
        // this is work in progress, not a pause: the agent is letting the reviewer finish, then fixes everything at once
        const note = `collecting ${fresh.length} review comments; fixing them together after 3 quiet minutes`;
        updateTask(taskId, { status: "monitoring", activity: note });
        await notifyTask(taskId, "running", `Review comments arrived; collecting them.`);
        if (previousBatch !== observed.batch?.fingerprint) {
          statusEvent("info", `Ticket ${task.ticket.id}: ${note}`);
          await say(slackLines.working(`Collecting ${fresh.length} review comment${fresh.length === 1 ? "" : "s"} from ${[...new Set(fresh.map(t => "@" + t.author))].join(", ")}; fixing them together once they stop for 3 minutes. Nothing needed from you`));
        }
        // poll faster while collecting, so the fix starts soon after the quiet period ends rather than up to a poll later
        const remaining = REVIEW_QUIET_MS - (Date.now() - (observed.batch?.stableSince ?? Date.now()));
        await nap(Math.max(30_000, Math.min(PR_POLL_MS, remaining + 5_000)));
        continue;
      }
      if (fresh.length) {
        log(task, `${fresh.length} new review thread(s)`);
        activity(`answering ${fresh.length} review thread${fresh.length === 1 ? "" : "s"}`);
        const text = await turn(RESPOND_TO_REVIEW(fresh), builderProvider, "implementation");
        await completeReply(text, undefined, "implementation");
        const afterFix = await readPr(job.repo, pr);
        const remaining = new Set(afterFix.unresolved.map((t) => t.threadId).filter(Boolean));
        const addressed = fresh.filter((t) => !t.threadId || !remaining.has(t.threadId));
        updateTask(task.id, (t) => ({ threadsSeen: [...t.threadsSeen, ...addressed.map((f) => f.id)], reviewBatch: undefined }));
        const sent = await requestReviewers(job.repo, pr, reviewersWithoutApproval(requested, [...afterFix.approvals, ...(afterFix.previousApprovers ?? [])]));
        updateTask(taskId, { reviewRequestedHead: afterFix.headSha, reviewRequestedAt: Date.now(), reviewWaitSince: Date.now() });
        if (sent.length) await say(`✅ Re-requested review from ${sent.map(n => "@" + n).join(", ")} after addressing feedback. Your action: none now.`);
        statusEvent("success", `Ticket ${task.ticket.id}: handled a batch of ${fresh.length} review comments`);
        await say(slackLines.answered(fresh.length, fresh.length - addressed.length));
        continue; // re-read straight away
      }
      if (state.mergeable === "CONFLICTING") {
        // a PR that does not merge cleanly is never handed off: bring the base in, resolve, push, and let CI and GitHub re-check
        conflictFixes++;
        if (conflictFixes > 3) throw new ProblemError({ where: "PR watch", what: `Still conflicting with ${job.base} after ${conflictFixes - 1} merge attempts`, why: ["Each attempt merged the base, resolved, and pushed; GitHub still reports conflicts"], ask: "Resolve by hand, or reply with how to resolve the conflicting files." });
        await say(slackLines.conflicts(job.base, conflictFixes));
        activity(`resolving merge conflicts with ${job.base}`);
        const answer = await turn(`PR ${prUrl} has merge conflicts with origin/${job.base}, so it cannot be merged. In this worktree: git fetch origin ${job.base}, then git merge origin/${job.base} into the branch. Resolve every conflict keeping both the branch's intent and the base's changes; never drop either side blindly. For generated files, regenerate rather than hand-edit. Run the relevant checks, commit the merge, and push. If a conflict needs a business or design decision, ask the owner. Never merge the PR itself.`, builderProvider, "implementation");
        await completeReply(answer, undefined, "implementation");
        await notifyTask(taskId, "monitoring", `Merge conflicts with ${job.base} resolved and pushed; waiting for GitHub to re-check and CI to run. Next check in 3m. Your action: none.`);
        updateTask(taskId, { status: "monitoring" });
        await nap(PR_POLL_MS);
        continue;
      }
      if (state.ci === "fail") {
        const answer = await turn(`PR ${prUrl} has failing CI. Read gh pr checks and the failed job logs, fix the failures in this branch, run relevant checks, commit and push. If a failure needs a business or design decision, ask the owner. Never merge.`, builderProvider, "implementation");
        await completeReply(answer, undefined, "implementation");
        await notifyTask(taskId, "monitoring", "CI repair pushed; waiting for GitHub checks on the repair. Consort will fix another failure automatically. Next check in 3m. Your action: none.");
        updateTask(taskId, { status: "monitoring" });
        await nap(PR_POLL_MS);
        continue;
      }
      const ready = prReadiness(state, [me], requested);
      if (ready.ready) {
        await tell(slackLines.ready(state.url));
        await finish("ready", "ready to merge");
        return;
      }
      log(task, `not ready: ${ready.reasons.join(", ")}`);
      const saved = loadState().tasks.find(t => t.id === taskId)!;
      const waitSince = saved.reviewWaitSince ?? Date.now();
      const approved = new Set(state.approvals.map(n => n.toLowerCase()));
      const pending = new Set(state.requestedReviewers.map(n => n.toLowerCase()));
      const needsRequest = reviewersWithoutApproval([...new Set([...(state.changesRequestedBy ?? []), ...requested.filter(n => !approved.has(n.toLowerCase()))])], [...state.approvals, ...(state.previousApprovers ?? [])]).filter(n => !pending.has(n.toLowerCase()));
      if (needsRequest.length && (!saved.reviewRequestedAt || saved.reviewRequestedHead !== state.headSha || Date.now() - saved.reviewRequestedAt >= 30 * 60_000)) {
        const sent = await requestReviewers(job.repo, pr, needsRequest);
        updateTask(taskId, { reviewRequestedHead: state.headSha, reviewRequestedAt: Date.now() });
        if (sent.length) await say(`✅ Re-requested review from ${sent.map(n => "@" + n).join(", ")}; waiting for their GitHub review. Your action: none now.`);
      }
      const waiting = reviewWaitMessage(state, requested, Date.now() - waitSince >= 60 * 60_000);
      updateTask(taskId, { status: "monitoring", activity: waiting, reviewWaitSince: waitSince });
      await notifyTask(taskId, "monitoring", waiting);
      } catch (e) {
        log(task, `Review loop needs help: ${(e as Error).message}`);
        const answer = await ask([slackLines.problem(problemOf(e, "PR watch", { recent: [...recent], ask: "Reply with what to do. The task stays open until a requested reviewer approves and CI passes." }), task.ticket.url)], true);
        recoveryGuidance = `The owner answered on Slack: ${answer}\nRecover the PR review/CI loop using this guidance. Fix and push what is needed; never merge.`;
      }
    }
    await nap(PR_POLL_MS);
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
  const tier = delegateModel ? `You are the orchestrator. Dispatch every delegated agent on \`${delegateModel}\`; at most one delegated reader may run at once.\n\n` : "";
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
