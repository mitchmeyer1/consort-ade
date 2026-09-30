import { beginDockerRun, dockerRunEnvironment, finishDockerRun } from "./dockerLifecycle";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";
import { store } from "./store";
import { startAgentBrowser } from "./agentBrowser";
import { agentEnvironment, isInstallCommand, TESTING_PROMPT } from "./agentEnvironment";
import { claudeBin, codexBin, loginEnv } from "./auth";
import { updateCli } from "./cliRuntime";
import { CLI_NAMES, cliUpdateNeeded } from "../shared/cliUpdates";
import { PHASES, type Chat, type Block, type Phase, type PermissionRequest } from "../shared/types";
import { advancePlan, finishPlan, parsePlan, PLAN_MARKER, startPlan, STEP_MARKER } from "../shared/planProgress";
import { completeFeatureItems, FEATURE_CLEAR_MARKER, FEATURE_DONE_MARKER, FEATURE_MARKER, FEATURE_NOW_MARKER, FEATURE_PROMPT, featureComplete, featureSummary, focusFeatureItem, parseFeature, startFeature } from "../shared/featureProgress";
import { firstPrompt, reviewDeliverable } from "../shared/skillSections";
import { FOLLOWUP_PROMPT } from "../shared/followups";
import { withInstructions } from "../shared/instructions";
import { BLOCKED_TOOLS, LOCAL_DELIVERABLES_PROMPT } from "../shared/deliverables";
import { isBenignCodexDiagnostic } from "../shared/codexDiagnostics";
import { AUTOPILOT_DRIVER_PROMPT, AUTOPILOT_SUGGESTION_PROMPT } from "../shared/autopilot";
import { startAutopilotBridge } from "./autopilotBridge";
import { defaultSeat, pickSeat, readPool, sessionOnSeat } from "./seatPool";
import { applyRateInfo, describeLimit, earliestReset, isCodexLimitText, isUsageLimitText, limitFromRateEvent, resetLabel, SEAT_CONTINUE_PROMPT, seatLoad, seatName, seatOf, type LimitHit } from "../shared/seatPool";
import { applyShipChange, isSlashCommand, parseShipMarkers, stripShipMarkers, withAttachments, type ShipFeature } from "../shared/ship";
import { CLEAR_DIVIDER, type SlashEntry } from "../shared/commands";
import { contextWindowOf, promptTokens } from "../shared/context";

// ponytail: phase tracked via text markers so claude + codex share one mechanism
const PHASE_PROMPT = `For EVERY new prompt, first assess the task and plan your approach before doing work. The ADE starts at waiting during this assessment.
Choose the progress flow before using tools or answering, and emit [steps:3] or [steps:5] on its own line.
Use 3 steps ONLY for simple factual or conversational questions requiring no code/file changes, substantial research, or validation: waiting → executing → complete. Plan briefly during the initial assessment, then emit [phase:executing] before answering and [phase:complete] when finished. Never jump straight to complete.
Use 5 steps for all other tasks: ${PHASES.join(" → ")}. Emit [steps:5], then [phase:planning] and describe the plan before acting. Continue through [phase:executing], [phase:validating], and [phase:complete] in order. Do not skip planning or validation. If a simple task grows in scope, upgrade with [steps:5] and plan before continuing.
Every phase marker belongs on its own line. Emit [phase:waiting] if you need user input; otherwise finish at complete. Select the flow anew for every prompt, including follow-ups and queued messages, regardless of the previous turn's flow.

Exception: a skill step that asks the user and waits (e.g. a grilling round). Post the questions, emit [phase:waiting], end the turn; never answer for the user or continue past them, even if told the user cannot answer.

Also lay out the specific work as a plan the user can watch. Once you know the approach and before your first tool call, emit on its own line [plan: first step | second step | verify step] — 2 to 6 steps, each an imperative phrase of at most six words naming a real unit of this task ("read the store", "add the field", "run the tests"), not the generic phases above. List them in the order you will do them, and emit [step:N] on its own line as you start step N (1-based), counting up, so the user sees where you are. If a step turns out wrong, emit a fresh [plan: …] rather than reworking the old one. Skip the plan entirely for a question you answer without tools. Agents you dispatch are attached to the step that is live when you dispatch them, so no marker is needed for them.
When the task changes code, data or configuration, or produces something that can be run, the last step is a check you actually run, named concretely: the repository's test suite or typecheck, the screenshot helper against the running app for anything visual, the CLI or endpoint you changed, a query against the data you migrated. Do the check, read its output, and say what it showed. If a check fails, fix and re-run it rather than reporting the failure as done; if nothing can be run, say plainly what you could not verify instead of claiming it passed. An investigation, an explanation, a plan for someone else to carry out, or a question answered from reading has no verification step — do not add one for form's sake. A step you never started is reported to the user as skipped, so do not declare work you will not do.

${FEATURE_PROMPT}

${FOLLOWUP_PROMPT}`;
// Autopilot exists only once an OpenRouter key is saved; until then the agent is not told to suggest it
const autopilotAvailable = () => { try { return !!store.getOpenRouterKey?.(); } catch { return false; } };
const basePrompt = () => [PHASE_PROMPT, LOCAL_DELIVERABLES_PROMPT, ...(autopilotAvailable() ? [AUTOPILOT_SUGGESTION_PROMPT] : [])].join("\n\n");
const PROGRESS_MARKER = /\[(?:steps:(3|5)|phase:(waiting|planning|executing|validating|complete))\]\s*/g;

// copy uploads into the worktree so the agent can Read them; keep them out of git
function stageFiles(cwd: string, files: string[]) {
  const dir = join(cwd, ".consort", "uploads", randomUUID());
  try {
    // worktrees share the main repo's info/exclude; ask git where it is
    const ex = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { cwd }).toString().trim();
    let cur = ""; try { cur = readFileSync(ex, "utf8"); } catch {}
    if (!cur.includes(".consort/")) appendFileSync(ex, "\n.consort/\n");
  } catch {}
  if (!files.length) return [];
  mkdirSync(dir, { recursive: true });
  return files.map((f) => { const dest = join(dir, basename(f)); copyFileSync(f, dest); return dest; });
}

const running = new Map<string, AbortController>();
const pending = new Map<string, { chatId: string; finish: (allow: boolean) => void }>();
// live provider sessions, so a permission-mode change reaches a run already in flight
const sessions = new Map<string, { setPermissionMode?: (mode: "bypassPermissions" | "acceptEdits") => Promise<void> }>();
let askPermission: (r: PermissionRequest) => void = () => {};
export const onPermission = (cb: typeof askPermission) => (askPermission = cb);
export const answerPermission = (id: string, allow: boolean) => pending.get(id)?.finish(allow);

// auto-approve applies immediately, mid-run: the current session is retuned and
// anything already waiting on the user is released
export function setAutoApprove(chatId: string, on: boolean) {
  const chat = store.chat(chatId);
  chat.autoApprove = on;
  store.save();
  void sessions.get(chatId)?.setPermissionMode?.(on ? "bypassPermissions" : "acceptEdits").catch(() => {});
  if (!on) return;
  for (const [, p] of [...pending]) if (p.chatId === chatId) p.finish(true);
}

export function stop(chatId: string) {
  store.chat(chatId).queuePaused = true;
  store.save();
  running.get(chatId)?.abort();
}

// stop a run and wait until it has actually wound down
export async function stopAndWait(chatId: string) {
  stop(chatId);
  for (let i = 0; i < 100 && store.chat(chatId).running; i++) await new Promise((r) => setTimeout(r, 100));
  if (store.chat(chatId).running) throw new Error("The agent is still stopping. Try switching again once it has stopped.");
}

// Bound transport input independently of the provider's token/context budget.
export const PROMPT_CHAR_BUDGET = 120_000;
export function isContextSizeError(message: string) {
  return /input_too_large|context_length_exceeded|maximum context length|context window[^\n]*(?:exceed|full)|Input exceeds the maximum length|prompt is too long/i.test(message);
}

function excerpt(text: string, cap: number) {
  if (text.length <= cap) return text;
  const marker = "\n…[middle omitted; full text archived]…\n";
  const head = Math.floor((cap - marker.length) / 3);
  return text.slice(0, head) + marker + text.slice(-(cap - marker.length - head));
}

function archiveContext(cwd: string, content: string, extension: string) {
  const dir = join(cwd, ".consort", "context");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.${extension}`);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

export function boundedPrompt(cwd: string, text: string) {
  if (text.length <= PROMPT_CHAR_BUDGET) return text;
  const path = archiveContext(cwd, text, "txt");
  const notice = `ADE shortened this oversized input. Full input: ${path}. Read needed sections in bounded chunks before acting; omitted text may contain requirements. Do not load the entire archive at once.\n\n`;
  return notice + excerpt(text, PROMPT_CHAR_BUDGET - notice.length);
}

// Preserve the original task as well as recent decisions; never change the stored chat.
export function transcriptDigest(chat: Chat, cap = 9000) {
  const lines = chat.messages.filter(m => m.role !== "system").map(m => {
    const parts = m.blocks.map(b => b.type === "text" ? b.text.trim() : `[tool ${b.name}: ${b.input.split("\n")[0].slice(0, 120)}${b.ok === false ? " → failed" : ""}]`).filter(Boolean);
    return parts.length ? `${m.role.toUpperCase()}:\n${excerpt(parts.join("\n"), 2400)}` : "";
  }).filter(Boolean);
  if (lines.join("\n\n").length <= cap) return lines.join("\n\n");
  const anchor = excerpt(lines[0], Math.floor(cap / 3));
  const marker = "\n\n…[older messages omitted]…\n\n";
  return anchor + marker + lines.slice(1).join("\n\n").slice(-(cap - anchor.length - marker.length));
}

function contextHandoff(chat: Chat, cwd: string) {
  const path = archiveContext(cwd, JSON.stringify(chat.messages), "json");
  chat.sessionId = undefined;
  chat.sessionKeyId = undefined;
  chat.messages.push({ id: randomUUID(), role: "system", blocks: [{ type: "text", text: "Context size limit reached. Continuing in a fresh session with a compact handoff; full history is preserved." }], ts: Date.now() });
  store.save();
  return `Continue the same task after a context-size failure. Check current files and completed tool actions before doing work again. Full prior transcript: ${path}; search/read only needed portions, never the whole archive. The following is a truncated handoff, not a complete summary:\n\n${transcriptDigest(chat, 24000)}`;
}

/** Codex pins a thread to the model that opened it, so resuming one on another model is refused. */
export const modelPinsSession = (provider: Chat["provider"]) => provider === "codex";

export async function switchAgent(chatId: string, keyId: string, model: string) {
  const chat = store.chat(chatId);
  const key = store.data.keys.find((k) => k.id === keyId);
  if (!key) throw new Error("unknown connector");
  const providerChanged = key.provider !== chat.provider;
  const connectorChanged = keyId !== chat.keyId;
  const modelChanged = model !== chat.model;
  if (chat.running) await stopAndWait(chatId);
  // A model the provider can't resume onto needs the same treatment as a change of agent: new session, fresh context.
  const restarts = providerChanged || (modelChanged && modelPinsSession(key.provider));
  // a session survives a move onto or off the pool when the target seat can see its transcript
  const from = keyOf(chat);
  const seatMove = connectorChanged && !restarts && !!(key.pool || from?.pool)
    && !!chat.sessionId && sessionOnSeat(key.pool ? chat.seatDir ?? store.data.seatPool?.picks[key.provider]?.dir ?? defaultSeat(key.provider) : key.configDir ?? defaultSeat(key.provider), chat.sessionId, key.provider);
  // Nothing to hand over without a live session: the next message already carries the transcript (see runSend).
  const handover = restarts && !!chat.sessionId && chat.messages.some((m) => m.role !== "system");
  const digest = handover ? transcriptDigest(chat) : "";
  if (seatMove) chat.sessionKeyId = keyId;
  else if (connectorChanged || restarts) {
    chat.sessionId = undefined;
    chat.sessionKeyId = undefined;
  }
  key.defaultModel = model;
  chat.keyId = keyId; chat.model = model; chat.provider = key.provider;
  if (!handover) { store.save(); return; }
  chat.messages.push({ id: randomUUID(), role: "system", blocks: [{ type: "text", text: providerChanged
    ? `Handed the conversation to ${key.provider} · ${model} (${key.name}).`
    : `Switched to ${model}. ${key.provider === "codex" ? "Codex" : "This provider"} can't resume a session on another model, so this continues in a fresh one with a context handoff.` }], ts: Date.now() });
  store.save();
  const who = providerChanged ? "another AI agent" : "an earlier model";
  const prompt = `You are taking over an in-progress conversation from ${who} working in this same repository/worktree. The earlier session can't be resumed, so this is a fresh one. Transcript so far:\n\n${digest}\n\nPick up where it left off: in one or two sentences say what you understand the task and current status to be, then continue the work. If the last step was a question to the user, ask it again briefly and emit [phase:waiting].`;
  await send(chatId, prompt, [], { silent: true });
}

const note = (chat: Chat, text: string) => chat.messages.push({ id: randomUUID(), role: "system", blocks: [{ type: "text", text }], ts: Date.now() });
const isPool = (chat: Chat) => !!keyOf(chat)?.pool;
const limitLabel = (hit: LimitHit) => `${describeLimit(hit)}${hit.resetsAt ? ` (resets ${resetLabel(hit.resetsAt)})` : ""}`;

/**
 * A pool chat keeps its seat, and that seat's warm prompt cache, until the seat is spent; only then,
 * or on its first message, does the chooser name one.
 */
async function ensureSeat(chat: Chat) {
  const cur = seatOf(store.data.seatPool, chat.seatDir);
  if (chat.seatDir && !(cur && (cur.blocked || seatLoad(cur, chat.model) >= 100))) return;
  const pool = await readPool().catch(() => store.data.seatPool);
  const pick = pickSeat(pool, chat.provider, { model: chat.model });
  chat.seatDir = pick?.dir ?? chat.seatDir ?? defaultSeat(chat.provider);
}

/**
 * The seat stopped mid-turn: move the same session to the seat with the most headroom that this
 * turn hasn't already spent, and tell it to carry on. With nowhere left to go, say when the first
 * seat reopens instead.
 */
async function recoverFromLimit(chatId: string, hit: LimitHit) {
  const chat = store.data.chats.find((c) => c.id === chatId);
  if (!chat || chat.running) return;
  const from = chat.seatDir;
  const tried = [...new Set([...(chat.seatTried ?? []), ...(from ? [from] : [])])];
  let pool = store.data.seatPool;
  let why = "";
  try { pool = (await readPool({ force: true })) ?? pool; }
  catch (e) { why = ` Reading the seats failed: ${(e as Error).message}.`; }
  const pick = pickSeat(pool, chat.provider, { exclude: tried, model: chat.model });
  const next = pick && !pick.blocked ? pick.dir : undefined;
  if (!next || tried.includes(next)) {
    const reset = earliestReset(pool, chat.provider);
    recordRunError(chat, `${seatName(pool, from)} hit its ${limitLabel(hit)}, and no other seat has headroom${reset ? `; the first one frees up ${resetLabel(reset)}` : ""}.${why} Pick a seat from the seat menu to force one, or continue after the reset.`);
    chat.seatTried = undefined;
    store.save();
    return;
  }
  chat.seatDir = next;
  chat.seatTried = tried;
  note(chat, `${seatName(pool, from)} hit its ${limitLabel(hit)}. Continuing on ${seatName(pool, next)}.`);
  chat.queuePaused = false;
  store.save();
  await runSend(chatId, SEAT_CONTINUE_PROMPT, [], { silent: true }).catch((e) => { recordRunError(chat, String((e as Error).message ?? e)); store.save(); });
}

/**
 * Moves a chat onto the seat pool (or to another seat within it) and picks the work back up.
 * `dir` forces a seat, even one over the chooser's ceilings; without it the chooser picks among the others.
 */
export async function switchSeat(chatId: string, dir?: string) {
  const chat = store.chat(chatId);
  const pool = store.data.keys.find((k) => k.pool && k.provider === chat.provider);
  if (!pool) throw new Error(`No seat pool for ${chat.provider}: add a second ${chat.provider === "claude" ? "Claude" : "Codex"} login in Settings.`);
  const from = keyOf(chat);
  const wasRunning = chat.running;
  if (wasRunning) await stopAndWait(chatId);
  const current = from?.pool ? chat.seatDir : from?.configDir ?? defaultSeat(chat.provider);
  let target = dir;
  if (!target) {
    const fresh = await readPool({ force: true });
    const pick = pickSeat(fresh, chat.provider, { exclude: current ? [current] : [], model: chat.model });
    if (!pick) throw new Error("There is no other seat to move to.");
    const reset = earliestReset(fresh, chat.provider);
    if (pick.blocked) throw new Error(`Every other seat is at its limit${reset ? `; the first frees up ${resetLabel(reset)}` : ""}.`);
    target = pick.dir;
  }
  chat.keyId = pool.id;
  chat.seatDir = target;
  chat.seatTried = undefined;
  // the session comes along when the target seat can see its transcript
  if (chat.sessionId && sessionOnSeat(target, chat.sessionId, chat.provider)) chat.sessionKeyId = pool.id;
  else { chat.sessionId = undefined; chat.sessionKeyId = undefined; }
  note(chat, `Moved to seat ${seatName(store.data.seatPool, target)}${current ? ` from ${seatName(store.data.seatPool, current)}` : ""}.`);
  const resume = wasRunning || !!chat.error || !!chat.interrupted;
  chat.queuePaused = false;
  store.save();
  if (resume) await continueChat(chatId, wasRunning ? "You were stopped mid-task so this session could move to another account." : undefined);
  else void flushQueued(chatId);
}

// pick a dead chat back up: what changed on disk since, what the agent produced, and (if the session is gone) the transcript
export async function continueChat(chatId: string, reason?: string) {
  const chat = store.chat(chatId);
  if (chat.running) return;
  const cwd = store.data.worktrees.find((w) => w.id === chat.worktreeId)!.path;
  const sh = (args: string[]) => new Promise<string>((res) => execFile("git", args, { cwd, maxBuffer: 1 << 22 }, (_e, out) => res(out || "")));
  const [status, recent, artifacts] = await Promise.all([
    sh(["status", "--short"]),
    sh(["log", "-5", "--format=%h %s (%cr)"]),
    new Promise<string>((res) => execFile("find", [".consort", "-type", "f", "-newermt", "-2 days"], { cwd }, (_e, out) => res(out || ""))),
  ]);
  const why = reason ?? (chat.error ? `Your previous run failed with: ${chat.error}` : "The app was closed while you were mid-task, so your previous run was cut off.");
  // a resumed review has lost the skill text from its context: the digest keeps only the head of the first prompt,
  // and the file schema lives at the tail. Re-attach that tail, or the run drifts to a Markdown page nobody can act on.
  const first = firstPrompt(chat);
  const pr = /PR #(\d+)/.exec(chat.name)?.[1] ?? /\bPR\s+#?(\d+)/.exec(first)?.[1];
  const sections = /pr-writeup/i.test(first) ? reviewDeliverable(first) : "";
  const deliverable = sections ? `This chat is a PR review run under the pr-writeup skill. Its deliverable is \`.consort/pr-review/pr-${pr ?? "<n>"}.review.json\` in the schema below, not a Markdown or HTML page: Consort renders the file and every Comment-on-PR / Ignore decision happens there. Reuse the brief and agent reports already under .consort/pr-review rather than re-reviewing, then write the file and end with the link.

${sections}

` : "";
  const prompt = `${why}
Pick up exactly where you left off and finish the task. Do not start over; check the current state first.

${deliverable}` +
    `Working tree now (git status --short):
${status.trim() || "(clean)"}

Recent commits:
${recent.trim() || "(none)"}

` +
    (artifacts.trim() ? `Files you produced under .consort/ (read them rather than regenerating):
${artifacts.trim()}

` : "") +
    (chat.sessionId && chat.provider === "claude" ? `Your earlier context should still be attached to this session; if it is not, here is the transcript:

${transcriptDigest(chat, 6000)}` : `Transcript so far:

${transcriptDigest(chat)}`) +
    `

Start with one sentence on where things stand, then continue.`;
  chat.messages.push({ id: randomUUID(), role: "system", blocks: [{ type: "text", text: "Resumed after interruption." }], ts: Date.now() });
  chat.interrupted = undefined;
  store.save();
  await send(chatId, prompt, [], { silent: true });
}

// Keep provider diagnostics when the SDK subsequently throws a generic process-exit error.
function recordRunError(chat: Chat, message: string) {
  if (!message || chat.error === message) return;
  chat.error = chat.error ? `${chat.error}\n\n${message}` : message;
}

const drainingQueues = new Set<string>();
export async function flushQueued(chatId: string) {
  if (drainingQueues.has(chatId)) return;
  const chat = store.data.chats.find((c) => c.id === chatId);
  if (!chat || chat.running || chat.queuePaused || !chat.queuedMessages?.length) return;
  drainingQueues.add(chatId);
  try {
    while (!chat.running && !chat.queuePaused && chat.queuedMessages?.length) {
      const next = chat.queuedMessages[0];
      await runSend(chatId, next.text, next.files, { queuedId: next.id, ...(next.display ? { display: next.display } : {}) });
      if (chat.error || chat.interrupted) chat.queuePaused = true;
    }
  } catch (error) {
    recordRunError(chat, String((error as Error).message ?? error));
    chat.queuePaused = true;
  } finally {
    drainingQueues.delete(chatId);
    store.save();
  }
}

/** /clear: the next send starts a fresh provider session with no transcript digest; the transcript stays on screen behind a divider */
export function clearChat(chatId: string) {
  const chat = store.chat(chatId);
  if (chat.running) throw new Error("Stop the chat before clearing its context.");
  chat.sessionId = undefined;
  chat.sessionKeyId = undefined;
  chat.cleared = true;
  chat.context = undefined;
  chat.feature = undefined;
  chat.error = undefined;
  chat.interrupted = undefined;
  chat.messages.push({ id: randomUUID(), role: "system", kind: "clear", blocks: [{ type: "text", text: CLEAR_DIVIDER }], ts: Date.now() });
  store.save();
}

// the slash commands a seat + worktree offers, read from the CLI at init with no model call; one fetch per pair until restart
const commandCache = new Map<string, SlashEntry[]>();
const inflight = new Map<string, Promise<SlashEntry[]>>();
const commandKey = (chat: Chat, cwd: string) => `${isPool(chat) ? chat.seatDir ?? "" : keyOf(chat)?.configDir ?? chat.keyId}|${cwd}`;
const toEntries = (list: unknown): SlashEntry[] => (Array.isArray(list) ? list : []).filter((c) => c && typeof c.name === "string")
  .map((c) => ({ name: c.name, description: c.description ?? "", ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) }));
export async function listCommands(chatId: string): Promise<SlashEntry[]> {
  const chat = store.chat(chatId);
  if (chat.provider !== "claude") return [];
  const cwd = store.data.worktrees.find((w) => w.id === chat.worktreeId)?.path;
  if (!cwd) return [];
  if (isPool(chat) && !chat.seatDir) await ensureSeat(chat);
  const key = commandKey(chat, cwd);
  const hit = commandCache.get(key);
  if (hit) return hit;
  let run = inflight.get(key);
  if (!run) {
    run = probeCommands(chat, cwd).then((list) => { commandCache.set(key, list); return list; }).finally(() => inflight.delete(key));
    inflight.set(key, run);
  }
  return run;
}
async function probeCommands(chat: Chat, cwd: string): Promise<SlashEntry[]> {
  const seat = isPool(chat) && chat.seatDir ? { CLAUDE_CONFIG_DIR: chat.seatDir } : {};
  const apiKey = store.getSecret(chat.keyId);
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 60_000);
  const q = query({ prompt: "hi", options: { cwd, abortController, tools: [], maxTurns: 1, settingSources: ["user", "project", "local"],
    env: agentEnvironment(cwd, { ...envWithout("ANTHROPIC_API_KEY"), ...loginEnv(keyOf(chat)), ...seat, ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}) }) } });
  try {
    for await (const m of q as AsyncIterable<SDKMessage>)
      if (m.type === "system" && m.subtype === "init") {
        const list = toEntries(await q.supportedCommands());
        abortController.abort();
        return list;
      }
  } catch (e) { if (!abortController.signal.aborted) throw e; }
  finally { clearTimeout(timer); }
  return [];
}

export async function send(chatId: string, text: string, files: string[] = [], opts: { silent?: boolean; display?: string } = {}) {
  if (opts.silent) return runSend(chatId, text, files, opts);
  const chat = store.chat(chatId);
  const cwd = store.data.worktrees.find((w) => w.id === chat.worktreeId)!.path;
  const staged = stageFiles(cwd, files);
  (chat.queuedMessages ??= []).push({ id: randomUUID(), text, files: staged, ...(opts.display ? { display: opts.display } : {}) });
  chat.lastChattedAt = Date.now();
  if (!chat.running) chat.queuePaused = false;
  store.save();
  void flushQueued(chatId);
}

async function runSend(chatId: string, text: string, files: string[] = [], opts: { silent?: boolean; queuedId?: string; display?: string } = {}) {
  const chat = store.chat(chatId);
  if (chat.running) throw new Error("chat is busy");
  const pooled = isPool(chat);
  let lost = false;
  if (pooled) {
    await ensureSeat(chat);
    if (chat.running) throw new Error("chat is busy");
    if (chat.sessionId && !sessionOnSeat(chat.seatDir!, chat.sessionId)) { chat.sessionId = undefined; chat.sessionKeyId = undefined; lost = true; }
  }
  const cwd = store.data.worktrees.find((w) => w.id === chat.worktreeId)!.path;
  // A session belongs to the login that created it, not just to the provider.
  // Also recover chats that hit this bug before session ownership was recorded.
  const missingSession = /(?:no (?:conversation|session) found|(?:session|conversation)[^\n]*(?:not found|does not exist)|(?:could(?: not|n't)|cannot|can't|unable to) find[^\n]*(?:session|conversation))/i.test(chat.error ?? "");
  // A session the provider refuses to resume on the current model: chats switched before Consort
  // started opening a new session for that are otherwise stuck failing on every message.
  const modelMismatch = /(?:conversation|thread|session)[^\n]*(?:started|created)[^\n]*\bmodel\b|\bmodel\b[^\n]*(?:does not|doesn't|did not|didn't) match/i.test(chat.error ?? "");
  if ((chat.sessionKeyId && chat.sessionKeyId !== chat.keyId) || missingSession || modelMismatch) {
    chat.sessionId = undefined;
    chat.sessionKeyId = undefined;
  }
  if (chat.provider === "codex" && isContextSizeError(chat.error ?? "")) {
    text = `${contextHandoff(chat, cwd)}\n\nCurrent request:\n${text}`;
  }
  const apiKey = store.getSecret(chat.keyId);
  const staged = opts.queuedId ? files : stageFiles(cwd, files);
  const shown = opts.display ?? text; // what the user typed; the files ride along as `attachments` and render as thumbnails
  // the CLI expands a skill only when the prompt starts with its command, and anything added becomes its arguments
  // (the attachment list rides along as arguments, so a screenshot no longer demotes /ship new to a plain prompt)
  const slash = chat.provider === "claude" && !opts.silent && isSlashCommand(text);
  // a silent continue normally rides its session; one that lost it to a seat move needs the transcript too
  if (!slash && !chat.sessionId && !chat.cleared && chat.messages.length && (!opts.silent || lost)) {
    text = `This is a fresh provider session for an existing chat in the same worktree. Use this transcript to retain the task and decisions; check the current files before repeating work.\n\n${transcriptDigest(chat)}\n\nCurrent user message:\n${text}`;
  }
  text = withAttachments(text, staged);
  // the feature outlives the turn, so the agent is reminded where it stands (a fresh session or a compacted context has no other way to know)
  if (!slash && chat.feature && !featureComplete(chat.feature)) text = `${text}\n\n${featureSummary(chat.feature)}`;
  if (!opts.silent) chat.messages.push({ id: randomUUID(), role: "user", blocks: [{ type: "text", text: shown }], ts: Date.now(), ...(staged.length ? { attachments: staged } : {}) });
  if (opts.queuedId) chat.queuedMessages = chat.queuedMessages?.filter((m) => m.id !== opts.queuedId);
  chat.unreadCompletion = false;
  chat.cleared = undefined; // a clear means clear: this send starts the fresh session with nothing but its own text
  chat.plan = undefined; // the plan belongs to the task being answered, not the chat
  // a reminder that has landed is answered by working here; one still counting down keeps its time
  if (chat.remindAt !== undefined && chat.remindAt <= Date.now()) chat.remindAt = undefined;
  chat.running = true;
  chat.error = undefined;
  chat.interrupted = undefined;
  chat.phase = "waiting";
  chat.phaseSteps = 5;
  chat.assessingPrompt = true;
  store.save();

  const ac = new AbortController();
  running.set(chatId, ac);
  const ui = new Transcript(chat);
  let browser: Awaited<ReturnType<typeof startAgentBrowser>> | undefined;
  let autopilot: Awaited<ReturnType<typeof startAutopilotBridge>> | undefined;
  let hit: LimitHit | undefined;
  try {
    const docker = beginDockerRun(chatId, chat.worktreeId);
    if (!slash) {
      text = `${TESTING_PROMPT}\n\n${docker ? `${docker}\n\n` : ""}${text}`;
      try {
        browser = await startAgentBrowser(cwd, ac.signal);
        text = `${browser.prompt}\n\n${text}`;
      } catch (error) {
        text = `The Consort screenshot helper could not start: ${(error as Error).message}. Shell/code tools are still available.\n\n${text}`;
      }
    }
    if (chat.autopilot) {
      try {
        autopilot = await startAutopilotBridge(cwd, ac.signal, () => !!chat.autopilot, () => store.getOpenRouterKey(), () => stop(chat.id));
        text = `${AUTOPILOT_DRIVER_PROMPT}\n\n${autopilot.prompt}\n\n${text}`;
      } catch (error) {
        text = `Autopilot could not start: ${(error as Error).message}. Do not attempt desktop control this turn.\n\n${text}`;
      }
    }
    // Codex bounds inside runCodex, once the instructions are on; bounding here too would archive the input twice
    // a CLI too old for the model is fetched and the turn run again, once (shared/cliUpdates.ts)
    for (let attempt = 0; attempt < 2; attempt++) {
      if (chat.provider === "claude") hit = await runClaude(chat, cwd, apiKey, boundedPrompt(cwd, text), ac, ui);
      else hit = await runCodex(chat, cwd, apiKey, text, ac, ui);
      const need = cliUpdateNeeded(chat.error, chat.provider);
      if (!need || attempt || ac.signal.aborted) break;
      const updated = await updateCli(chat.provider, need).catch(() => false);
      if (!updated || ac.signal.aborted) break;
      chat.messages.push({ id: randomUUID(), role: "system", blocks: [{ type: "text", text: `${need.reason} ${CLI_NAMES[chat.provider]} was updated; retrying.` }], ts: Date.now() });
      chat.error = undefined;
      ui.newMessage();
      store.save();
    }
    // off the pool there is no other seat to move to: say which limit, and when it lifts
    if (hit && !pooled) {
      recordRunError(chat, `${keyOf(chat)?.name ?? "This login"} hit its ${limitLabel(hit)}.${store.data.keys.some((k) => k.pool) ? " Switch seat to continue on another account." : ""}`);
      hit = undefined;
    }
    // a finished turn that isn't asking the user anything is complete, whatever steps it skipped
    if (!hit && !chat.error && !ac.signal.aborted && (chat.assessingPrompt || (chat.phase as Phase) !== "waiting")) chat.phase = "complete";
  } catch (e) {
    if (!ac.signal.aborted) recordRunError(chat, String((e as Error).message ?? e));
  } finally {
    await autopilot?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await finishDockerRun(chatId).catch(() => {
      chat.messages.push({ id: randomUUID(), role: "system", blocks: [{ type: "text", text: "Docker cleanup could not finish. Consort will retry automatically when Docker is available." }], ts: Date.now() });
    });
    running.delete(chatId);
    chat.running = false;
    chat.assessingPrompt = false;
    // a limit hit is not the end of the turn: the plan and feature carry over to the seat that picks it up
    const done = !ac.signal.aborted && !chat.error && !hit;
    if (chat.plan && done) chat.plan = finishPlan(chat.plan, Date.now());
    if (chat.feature && featureComplete(chat.feature) && done) chat.feature = undefined;
    if (done) chat.seatTried = undefined;
    chat.permissions = [];
    if (done && (chat.phase as Phase) !== "waiting") {
      chat.phase = "complete";
      chat.unreadCompletion = !chat.queuedMessages?.length;
    } else if (ac.signal.aborted || hit) chat.phase = "waiting";
    if (ac.signal.aborted || chat.error || hit) chat.queuePaused = true;
    store.save();
    if (hit && !ac.signal.aborted) void recoverFromLimit(chatId, hit);
    else void flushQueued(chatId);
  }
}

/** called when a reply moved a /ship feature; main writes the stage to the ticket */
let shipChanged: (worktreeId: string, before: ShipFeature, after: ShipFeature, note?: string) => void = () => {};
export const onShipChanged = (fn: typeof shipChanged) => { shipChanged = fn; };

class Transcript {
  private msg?: Chat["messages"][number];
  private timer?: NodeJS.Timeout;
  constructor(private chat: Chat) {}

  private assistant() {
    if (!this.msg) {
      this.msg = { id: randomUUID(), role: "assistant", blocks: [], ts: Date.now() };
      this.chat.messages.push(this.msg);
    }
    return this.msg;
  }
  newMessage() {
    this.msg = undefined;
  }
  text(t: string, append = true) {
    const blocks = this.assistant().blocks;
    const last = blocks[blocks.length - 1];
    if (append && last?.type === "text") last.text += t;
    else blocks.push({ type: "text", text: t });
    this.flush();
  }
  tool(b: Extract<Block, { type: "tool" }>) {
    const blocks = this.assistant().blocks;
    const i = blocks.findIndex((x) => x.type === "tool" && x.id === b.id);
    if (i >= 0) blocks[i] = { ...blocks[i], ...b };
    else blocks.push(b);
    this.flush();
  }
  toolResult(id: string, output: string, ok: boolean) {
    for (const m of this.chat.messages)
      for (const b of m.blocks) if (b.type === "tool" && b.id === id) Object.assign(b, { output, ok });
    this.flush();
  }
  // strip markers from display text and apply them to the phase
  finalizeText() {
    for (const b of this.assistant().blocks) {
      if (b.type !== "text") continue;
      for (const m of b.text.matchAll(PROGRESS_MARKER)) {
        if (m[1]) this.chat.phaseSteps = Number(m[1]) as 3 | 5;
        if (m[2]) {
          this.chat.phase = m[2] as Phase;
          this.chat.assessingPrompt = false;
          if (m[2] === "planning" || m[2] === "validating") this.chat.phaseSteps = 5;
        }
      }
      // the agent's own plan for this task, and where in it we are
      for (const m of b.text.matchAll(PLAN_MARKER)) {
        const steps = parsePlan(m[1] ?? "");
        if (steps.length) this.chat.plan = startPlan(steps, Date.now());
      }
      for (const m of b.text.matchAll(STEP_MARKER)) {
        if (this.chat.plan) this.chat.plan = advancePlan(this.chat.plan, Number(m[1]), Date.now());
      }
      // the larger checklist this task is part of, kept across turns
      for (const m of b.text.matchAll(FEATURE_MARKER)) {
        const parsed = parseFeature(m[1] ?? "");
        if (parsed) this.chat.feature = startFeature(parsed, this.chat.feature, Date.now());
      }
      for (const m of b.text.matchAll(FEATURE_DONE_MARKER)) {
        if (this.chat.feature) this.chat.feature = completeFeatureItems(this.chat.feature, m[1] ?? "", Date.now());
      }
      for (const m of b.text.matchAll(FEATURE_NOW_MARKER)) {
        if (this.chat.feature) this.chat.feature = focusFeatureItem(this.chat.feature, Number(m[1]));
      }
      if (FEATURE_CLEAR_MARKER.test(b.text)) this.chat.feature = undefined;
      FEATURE_CLEAR_MARKER.lastIndex = 0;
      // a /ship turn reports stage moves, PRs and artifacts on the feature's worktree; the ticket follows
      const shipChange = parseShipMarkers(b.text);
      if (shipChange) {
        const w = store.data.worktrees.find((x) => x.id === this.chat.worktreeId);
        if (w?.ship) { const before = w.ship; w.ship = applyShipChange(w.ship, shipChange, Date.now()); shipChanged(w.id, before, w.ship, shipChange.note); }
      }
      b.text = stripShipMarkers(b.text);
      b.text = b.text.replace(PROGRESS_MARKER, "").replace(PLAN_MARKER, "").replace(STEP_MARKER, "")
        .replace(FEATURE_MARKER, "").replace(FEATURE_DONE_MARKER, "").replace(FEATURE_NOW_MARKER, "").replace(FEATURE_CLEAR_MARKER, "");
    }
    const m = this.assistant();
    m.blocks = m.blocks.filter((b) => b.type !== "text" || b.text.trim());
    this.flush(true);
  }
  flush(now = false) {
    if (now) {
      clearTimeout(this.timer);
      this.timer = undefined;
      store.save();
    } else if (!this.timer) this.timer = setTimeout(() => this.flush(true), 80);
  }
}

/**
 * Pins the tier for every agent this chat dispatches, so a delegation the orchestrator
 * sends without an explicit model override still lands on the cheaper model rather than
 * inheriting the orchestrator's. The skill also passes the model per dispatch; this is
 * the backstop for the dispatch that forgets.
 */
const delegateModelEnv = (chat: Chat) => chat.delegateModel ? { CLAUDE_CODE_SUBAGENT_MODEL: chat.delegateModel } : {};

// Question dialogs have nowhere to render here; without the tool the agent asks in its reply and waits.
const HIDDEN_TOOLS = ["AskUserQuestion"];

/** runs one turn; returns the usage limit that stopped it, if one did */
async function runClaude(chat: Chat, cwd: string, apiKey: string, text: string, ac: AbortController, ui: Transcript): Promise<LimitHit | undefined> {
  chat.sessionKeyId = chat.keyId;
  const seat = isPool(chat) && chat.seatDir ? { CLAUDE_CONFIG_DIR: chat.seatDir } : {};
  let rejected: LimitHit | undefined;
  let limitText: string | undefined;
  const partialJson = new Map<number, { id: string; name: string; json: string }>();
  let lastPrompt: number | undefined; // the prompt size of the turn's latest API call, for the context meter
  const q = query({
    prompt: text,
    options: {
      cwd,
      // resolved per turn, so a CLI downloaded mid-session runs the next turn (main/cliRuntime.ts)
      pathToClaudeCodeExecutable: claudeBin(),
      model: chat.model,
      resume: chat.sessionId,
      abortController: ac,
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code", append: withInstructions(basePrompt(), store.data.instructions) },
      // hosted docs are never a deliverable here (see shared/deliverables); block the connector outright, whatever the account has enabled
      disallowedTools: [...BLOCKED_TOOLS, ...HIDDEN_TOOLS],
      env: agentEnvironment(cwd, { ...envWithout("ANTHROPIC_API_KEY"), ...loginEnv(keyOf(chat)), ...seat, ...dockerRunEnvironment(chat.id), ...delegateModelEnv(chat), ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}) }),
      // a spent seat must end the turn, not sit waiting hours for its reset: Consort moves the session instead
      settings: { autoContinueAtUsageLimit: false },
      permissionMode: chat.autoApprove ? "bypassPermissions" : "acceptEdits",
      // permits a later switch into bypass; canUseTool still gates every call
      allowDangerouslySkipPermissions: true,
      canUseTool: async (tool, input) => {
        // read auto-approve now, not at session start, so toggling it mid-conversation takes effect
        if (chat.autoApprove) return { behavior: "allow", updatedInput: input };
        // dependency installs never wait on the user (see isInstallCommand); everything else asks
        if (tool === "Bash" && isInstallCommand((input as any)?.command)) return { behavior: "allow", updatedInput: input };
        const id = randomUUID();
        const request = { id, chatId: chat.id, tool, input };
        const allow = await new Promise<boolean>((res) => {
          const finish = (allow: boolean) => {
            ac.signal.removeEventListener("abort", abort);
            pending.delete(id);
            chat.permissions = chat.permissions?.filter((p) => p.id !== id);
            store.save();
            res(allow);
          };
          const abort = () => finish(false);
          pending.set(id, { chatId: chat.id, finish });
          if (ac.signal.aborted) { finish(false); return; }
          ac.signal.addEventListener("abort", abort, { once: true });
          chat.permissions = [...(chat.permissions ?? []), request];
          store.save();
          askPermission(request);
        });
        return allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "User denied" };
      },
    },
  });
  sessions.set(chat.id, q as Parameters<typeof sessions.set>[1]);
  try {
  for await (const m of q as AsyncIterable<SDKMessage>) {
    if (m.type === "system" && m.subtype === "init") {
      chat.sessionId = m.session_id;
    } else if (m.type === "system" && (m as any).subtype === "commands_changed") {
      // skills discovered mid-turn: the SDK says to replace the cached list wholesale
      commandCache.set(commandKey(chat, cwd), toEntries((m as any).commands));
    } else if (m.type === "stream_event") {
      const e = m.event as any;
      if (e.type === "message_start") ui.newMessage();
      else if (e.type === "content_block_start" && e.content_block.type === "tool_use") {
        partialJson.set(e.index, { id: e.content_block.id, name: e.content_block.name, json: "" });
        ui.tool({ type: "tool", id: e.content_block.id, name: e.content_block.name, input: "" });
      } else if (e.type === "content_block_delta") {
        if (e.delta.type === "text_delta") ui.text(e.delta.text);
        else if (e.delta.type === "input_json_delta") {
          const t = partialJson.get(e.index);
          if (t) t.json += e.delta.partial_json;
        }
      } else if (e.type === "content_block_stop") {
        const t = partialJson.get(e.index);
        if (t) ui.tool({ type: "tool", id: t.id, name: t.name, input: pretty(t.json) });
        partialJson.delete(e.index);
      } else if (e.type === "message_stop") ui.finalizeText();
    } else if (m.type === "user" && !("isReplay" in m && m.isReplay)) {
      const content = (m.message as any).content;
      if (Array.isArray(content))
        for (const c of content)
          if (c.type === "tool_result") ui.toolResult(c.tool_use_id, flatten(c.content), !c.is_error);
    } else if (m.type === "rate_limit_event") {
      // every turn reports its seat's windows; a rejection names the window that stopped it and when it lifts
      const info = (m as any).rate_limit_info;
      if (isPool(chat)) store.data.seatPool = applyRateInfo(store.data.seatPool, chat.seatDir, info);
      rejected = limitFromRateEvent(info) ?? rejected;
    } else if (m.type === "assistant" && promptTokens((m.message as any)?.usage)) {
      lastPrompt = promptTokens((m.message as any)?.usage);
      if (m.error === "rate_limit" || m.error === "billing_error") { const said = flatten((m.message as any)?.content); if (isUsageLimitText(said)) limitText = said; }
    } else if (m.type === "assistant" && (m.error === "rate_limit" || m.error === "billing_error")) {
      const said = flatten((m.message as any)?.content);
      if (isUsageLimitText(said)) limitText = said;
    } else if (m.type === "result") {
      // a usage limit ends the turn as a "success" flagged is_error, with the limit notice as its result
      const said = [(m as any).result, ...((m as any).errors ?? [])].find(isUsageLimitText);
      if (said) limitText = said;
      else if (m.subtype !== "success") recordRunError(chat, (m as any).errors?.join("\n") || m.subtype);
      const window = contextWindowOf((m as any).modelUsage, chat.model);
      if (lastPrompt && window) chat.context = { used: lastPrompt, window, at: Date.now() };
      ui.finalizeText();
    }
  }
  } finally {
    sessions.delete(chat.id);
  }
  return limitText && !ac.signal.aborted ? { text: limitText, window: rejected?.window, resetsAt: rejected?.resetsAt } : undefined;
}

/** runs one turn; returns the usage limit that stopped it, if one did */
async function runCodex(chat: Chat, cwd: string, apiKey: string, text: string, ac: AbortController, ui: Transcript): Promise<LimitHit | undefined> {
  chat.sessionKeyId = chat.keyId;
  const seat = isPool(chat) && chat.seatDir ? { CODEX_HOME: chat.seatDir } : {};
  let limitText: string | undefined;
  // a usage limit is not a run error: the pool moves the chat to another seat instead
  const fail = (message: string) => { if (isCodexLimitText(message)) limitText = message; else recordRunError(chat, message); };
  const codex = new Codex({ ...(apiKey ? { apiKey } : {}), codexPathOverride: codexBin(), env: agentEnvironment(cwd, { ...envWithout("OPENAI_API_KEY"), ...loginEnv(keyOf(chat)), ...seat, ...dockerRunEnvironment(chat.id) }) });
  const opts = { ...(chat.model ? { model: chat.model } : {}), workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode: "workspace-write" as const, networkAccessEnabled: true, approvalPolicy: "never" as const };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
    const thread = chat.sessionId ? codex.resumeThread(chat.sessionId, opts) : codex.startThread(opts);
    const prompt = boundedPrompt(cwd, `${withInstructions(basePrompt(), store.data.instructions)}\n\n${text}`);
    const { events } = await thread.runStreamed(prompt, { signal: ac.signal });
    for await (const ev of events) {
      if (ev.type === "thread.started") chat.sessionId = ev.thread_id;
      else if (ev.type === "item.started" || ev.type === "item.updated" || ev.type === "item.completed") {
        const it = ev.item;
        if (it.type === "agent_message") {
          ui.newMessage();
          ui.text(it.text, false);
          ui.finalizeText();
        } else if (it.type === "command_execution")
          ui.tool({ type: "tool", id: it.id, name: "Bash", input: it.command, output: it.aggregated_output, ok: it.exit_code === undefined ? undefined : it.exit_code === 0 });
        else if (it.type === "file_change")
          ui.tool({ type: "tool", id: it.id, name: "Edit", input: it.changes.map((c) => `${c.kind} ${c.path}`).join("\n"), ok: it.status === "completed" });
        else if (it.type === "error" && !isBenignCodexDiagnostic(it.message)) fail(it.message);
      } else if (ev.type === "turn.failed") fail(ev.error.message);
      else if (ev.type === "error" && !isBenignCodexDiagnostic(ev.message)) fail(ev.message);
    }
    ui.finalizeText();
    } catch (error) {
      fail(String((error as Error).message ?? error));
    }
    if (ac.signal.aborted || !isContextSizeError(chat.error ?? "") || attempt === 1) break;
    const handoff = contextHandoff(chat, cwd);
    chat.error = undefined;
    chat.sessionKeyId = chat.keyId;
    ui.newMessage();
    text = boundedPrompt(cwd, `${handoff}\n\nRequest and runtime instructions for this turn:\n${text}`);
  }
  return limitText && !ac.signal.aborted ? { text: limitText } : undefined;
}

const envWithout = (k: string) => { const { [k]: _drop, ...rest } = process.env; return rest; };
const keyOf = (chat: Chat) => store.data.keys.find((k) => k.id === chat.keyId);
const pretty = (json: string) => {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
};
const flatten = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x?.type === "text" ? x.text : "")).join("\n") : "";
