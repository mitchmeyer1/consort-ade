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
import { loginEnv } from "./auth";
import { PHASES, type Chat, type Block, type Phase, type PermissionRequest } from "../shared/types";
import { advancePlan, finishPlan, parsePlan, PLAN_MARKER, startPlan, STEP_MARKER } from "../shared/planProgress";

// ponytail: phase tracked via text markers so claude + codex share one mechanism
const PHASE_PROMPT = `For EVERY new prompt, first assess the task and plan your approach before doing work. The ADE starts at waiting during this assessment.
Choose the progress flow before using tools or answering, and emit [steps:3] or [steps:5] on its own line.
Use 3 steps ONLY for simple factual or conversational questions requiring no code/file changes, substantial research, or validation: waiting → executing → complete. Plan briefly during the initial assessment, then emit [phase:executing] before answering and [phase:complete] when finished. Never jump straight to complete.
Use 5 steps for all other tasks: ${PHASES.join(" → ")}. Emit [steps:5], then [phase:planning] and describe the plan before acting. Continue through [phase:executing], [phase:validating], and [phase:complete] in order. Do not skip planning or validation. If a simple task grows in scope, upgrade with [steps:5] and plan before continuing.
Every phase marker belongs on its own line. Emit [phase:waiting] if you need user input; otherwise finish at complete. Select the flow anew for every prompt, including follow-ups and queued messages, regardless of the previous turn's flow.

Also lay out the specific work as a plan the user can watch. Once you know the approach and before your first tool call, emit on its own line [plan: first step | second step | verify step] — 2 to 6 steps, each an imperative phrase of at most six words naming a real unit of this task ("read the store", "add the field", "run the tests"), not the generic phases above. List them in the order you will do them, and emit [step:N] on its own line as you start step N (1-based), counting up, so the user sees where you are. If a step turns out wrong, emit a fresh [plan: …] rather than reworking the old one. Skip the plan entirely for a question you answer without tools. Agents you dispatch are attached to the step that is live when you dispatch them, so no marker is needed for them.
The last step is always verification, and it must be a check you actually run, named concretely: the repository's test suite or typecheck, the screenshot helper against the running app for anything visual, the CLI or endpoint you changed, a query against the data you migrated. Do the check, read its output, and say what it showed. If a check fails, fix and re-run it rather than reporting the failure as done; if nothing can be run, say plainly what you could not verify instead of claiming it passed. A step you never started is reported to the user as skipped, so do not declare work you will not do.`;
const PROGRESS_MARKER = /\[(?:steps:(3|5)|phase:(waiting|planning|executing|validating|complete))\]\s*/g;

const PHI_MARKER = /\[phi-required\]\s*/g;
const phiPrompt = (allowed: boolean) =>
  allowed
    ? "This chat's API key IS approved for PHI (protected health information)."
    : `This chat's API key is NOT approved for PHI. PHI mode is controlled manually by the user. Do not infer or change PHI mode from message keywords or attachment types.`;

export function setPhiMode(chat: Chat, on: boolean, reason?: string) {
  const cur = store.data.keys.find((k) => k.id === chat.keyId);
  if (!!cur?.phiAllowed === on) return true;
  const next = store.data.keys.find((k) => k.provider === chat.provider && k.phiAllowed === on);
  const note = next
    ? `PHI mode ${on ? "on" : "off"} — switched to key "${next.name}"${reason ? ` (${reason})` : ""}.`
    : `No ${on ? "PHI-approved" : "non-PHI"} ${chat.provider} key configured — add one in Settings.`;
  if (next) {
    if (chat.sessionId) chat.sessionKeyId ??= chat.keyId;
    chat.keyId = next.id;
  }
  chat.messages.push({ id: randomUUID(), role: "system", blocks: [{ type: "text", text: note }], ts: Date.now() });
  return !!next;
}

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
  // Nothing to hand over without a live session: the next message already carries the transcript (see runSend).
  const handover = restarts && !!chat.sessionId && chat.messages.some((m) => m.role !== "system");
  const digest = handover ? transcriptDigest(chat) : "";
  if (connectorChanged || restarts) {
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

// pick a dead chat back up: what changed on disk since, what the agent produced, and (if the session is gone) the transcript
export async function continueChat(chatId: string) {
  const chat = store.chat(chatId);
  if (chat.running) return;
  const cwd = store.data.worktrees.find((w) => w.id === chat.worktreeId)!.path;
  const sh = (args: string[]) => new Promise<string>((res) => execFile("git", args, { cwd, maxBuffer: 1 << 22 }, (_e, out) => res(out || "")));
  const [status, recent, artifacts] = await Promise.all([
    sh(["status", "--short"]),
    sh(["log", "-5", "--format=%h %s (%cr)"]),
    new Promise<string>((res) => execFile("find", [".consort", "-type", "f", "-newermt", "-2 days"], { cwd }, (_e, out) => res(out || ""))),
  ]);
  const why = chat.error ? `Your previous run failed with: ${chat.error}` : "The app was closed while you were mid-task, so your previous run was cut off.";
  const prompt = `${why}
Pick up exactly where you left off and finish the task. Do not start over; check the current state first.

` +
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
      await runSend(chatId, next.text, next.files, { queuedId: next.id });
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

export async function send(chatId: string, text: string, files: string[] = [], opts: { silent?: boolean } = {}) {
  if (opts.silent) return runSend(chatId, text, files, opts);
  const chat = store.chat(chatId);
  const cwd = store.data.worktrees.find((w) => w.id === chat.worktreeId)!.path;
  const staged = stageFiles(cwd, files);
  (chat.queuedMessages ??= []).push({ id: randomUUID(), text, files: staged });
  chat.lastChattedAt = Date.now();
  if (!chat.running) chat.queuePaused = false;
  store.save();
  void flushQueued(chatId);
}

async function runSend(chatId: string, text: string, files: string[] = [], opts: { silent?: boolean; queuedId?: string } = {}) {
  const chat = store.chat(chatId);
  if (chat.running) throw new Error("chat is busy");
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
  const shown = text; // what the user typed; the files ride along as `attachments` and render as thumbnails
  if (!chat.sessionId && chat.messages.length && !opts.silent) {
    text = `This is a fresh provider session for an existing chat in the same worktree. Use this transcript to retain the task and decisions; check the current files before repeating work.\n\n${transcriptDigest(chat)}\n\nCurrent user message:\n${text}`;
  }
  if (staged.length) text = `${text}\n\nAttached files (read them from disk):\n${staged.map((f) => `- ${f}`).join("\n")}`;
  if (!opts.silent) chat.messages.push({ id: randomUUID(), role: "user", blocks: [{ type: "text", text: shown }], ts: Date.now(), ...(staged.length ? { attachments: staged } : {}) });
  if (opts.queuedId) chat.queuedMessages = chat.queuedMessages?.filter((m) => m.id !== opts.queuedId);
  chat.unreadCompletion = false;
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
  try {
    text = `${TESTING_PROMPT}\n\n${beginDockerRun(chatId, chat.worktreeId)}\n\n${text}`;
    try {
      browser = await startAgentBrowser(cwd, ac.signal);
      text = `${browser.prompt}\n\n${text}`;
    } catch (error) {
      text = `The Consort screenshot helper could not start: ${(error as Error).message}. Shell/code tools are still available.\n\n${text}`;
    }
    text = boundedPrompt(cwd, text);
    if (chat.provider === "claude") await runClaude(chat, cwd, apiKey, text, ac, ui);
    else await runCodex(chat, cwd, apiKey, text, ac, ui);
    // a finished turn that isn't asking the user anything is complete, whatever steps it skipped
    if (!chat.error && !ac.signal.aborted && (chat.assessingPrompt || (chat.phase as Phase) !== "waiting")) chat.phase = "complete";
  } catch (e) {
    if (!ac.signal.aborted) recordRunError(chat, String((e as Error).message ?? e));
  } finally {
    await browser?.close().catch(() => {});
    await finishDockerRun(chatId).catch(() => {
      chat.messages.push({ id: randomUUID(), role: "system", blocks: [{ type: "text", text: "Docker cleanup could not finish. Consort will retry automatically when Docker is available." }], ts: Date.now() });
    });
    running.delete(chatId);
    chat.running = false;
    chat.assessingPrompt = false;
    if (chat.plan && !ac.signal.aborted && !chat.error) chat.plan = finishPlan(chat.plan, Date.now());
    chat.permissions = [];
    if (!ac.signal.aborted && !chat.error && (chat.phase as Phase) !== "waiting") {
      chat.phase = "complete";
      chat.unreadCompletion = !chat.queuedMessages?.length;
    } else if (ac.signal.aborted) chat.phase = "waiting";
    if (ac.signal.aborted || chat.error) chat.queuePaused = true;
    store.save();
    void flushQueued(chatId);
  }
}

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
      b.text = b.text.replace(PROGRESS_MARKER, "").replace(PLAN_MARKER, "").replace(STEP_MARKER, "").replace(PHI_MARKER, "");
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

async function runClaude(chat: Chat, cwd: string, apiKey: string, text: string, ac: AbortController, ui: Transcript) {
  chat.sessionKeyId = chat.keyId;
  const partialJson = new Map<number, { id: string; name: string; json: string }>();
  const q = query({
    prompt: text,
    options: {
      cwd,
      model: chat.model,
      resume: chat.sessionId,
      abortController: ac,
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code", append: `${PHASE_PROMPT}\n\n${phiPrompt(keyAllowsPhi(chat))}` },
      env: agentEnvironment(cwd, { ...envWithout("ANTHROPIC_API_KEY"), ...loginEnv(keyOf(chat)), ...dockerRunEnvironment(chat.id), ...delegateModelEnv(chat), ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}) }),
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
    } else if (m.type === "result") {
      if (m.subtype !== "success") recordRunError(chat, (m as any).errors?.join("\n") || m.subtype);
      ui.finalizeText();
    }
  }
  } finally {
    sessions.delete(chat.id);
  }
}

async function runCodex(chat: Chat, cwd: string, apiKey: string, text: string, ac: AbortController, ui: Transcript) {
  chat.sessionKeyId = chat.keyId;
  const codex = new Codex({ ...(apiKey ? { apiKey } : {}), env: agentEnvironment(cwd, { ...envWithout("OPENAI_API_KEY"), ...loginEnv(keyOf(chat)), ...dockerRunEnvironment(chat.id) }) });
  const opts = { ...(chat.model ? { model: chat.model } : {}), workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode: "workspace-write" as const, networkAccessEnabled: true, approvalPolicy: "never" as const };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
    const thread = chat.sessionId ? codex.resumeThread(chat.sessionId, opts) : codex.startThread(opts);
    const prompt = `${PHASE_PROMPT}\n\n${phiPrompt(keyAllowsPhi(chat))}\n\n${boundedPrompt(cwd, text)}`;
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
        else if (it.type === "error") recordRunError(chat, it.message);
      } else if (ev.type === "turn.failed") recordRunError(chat, ev.error.message);
      else if (ev.type === "error") recordRunError(chat, ev.message);
    }
    ui.finalizeText();
    } catch (error) {
      recordRunError(chat, String((error as Error).message ?? error));
    }
    if (ac.signal.aborted || !isContextSizeError(chat.error ?? "") || attempt === 1) break;
    const handoff = contextHandoff(chat, cwd);
    chat.error = undefined;
    chat.sessionKeyId = chat.keyId;
    ui.newMessage();
    text = boundedPrompt(cwd, `${handoff}\n\nRequest and runtime instructions for this turn:\n${text}`);
  }
}

const envWithout = (k: string) => { const { [k]: _drop, ...rest } = process.env; return rest; };
const keyOf = (chat: Chat) => store.data.keys.find((k) => k.id === chat.keyId);
const keyAllowsPhi = (chat: Chat) => !!keyOf(chat)?.phiAllowed;
const pretty = (json: string) => {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
};
const flatten = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x?.type === "text" ? x.text : "")).join("\n") : "";
