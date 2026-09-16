import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";
import { store } from "./store";
import { PHASES, type Chat, type Block, type Phase, type PermissionRequest } from "../shared/types";

// ponytail: phase tracked via text markers so claude + codex share one mechanism
const PHASE_PROMPT = `You are working inside an ADE that shows a 5-step progress bar: ${PHASES.join(" → ")}.
Whenever you move to a new step, emit the marker [phase:<step>] on its own line (e.g. [phase:executing]).
Start non-trivial tasks with [phase:planning]; use [phase:validating] while testing; [phase:complete] when done; [phase:waiting] when you need the user.`;
const MARKER = /\[phase:(waiting|planning|executing|validating|complete)\]\s*/g;
const PHI_MARKER = /\[phi-required\]\s*/g;
const phiPrompt = (allowed: boolean) =>
  allowed
    ? "This chat's API key IS approved for PHI (protected health information)."
    : `This chat's API key is NOT approved for PHI. Before touching anything that may contain PHI (production databases, patient records, uploaded spreadsheets of people's names/DOBs/contact info), STOP: do not read it, emit [phi-required] and [phase:waiting], and tell the user in one line; the ADE will swap in a PHI-approved key and they will resume.`;

// ponytail: keyword + file-type heuristic; false positives just flip to the safer key
const PHI_FILES = /\.(csv|tsv|xlsx?|json|sql|parquet)$/i;
const PHI_WORDS = /\b(prod(uction)?\b|snowflake|live (db|database|data)|patients?\b|\bphi\b|\bpii\b|\bssn\b|date of birth|\bdob\b|medical record|health record)/i;
export function phiSuspect(text: string, files: string[]) {
  const f = files.find((f) => PHI_FILES.test(f));
  if (f) return `attachment ${basename(f)} may contain personal data`;
  const m = PHI_WORDS.exec(text);
  return m ? `message mentions "${m[0]}"` : null;
}

export function setPhiMode(chat: Chat, on: boolean, reason?: string) {
  const cur = store.data.keys.find((k) => k.id === chat.keyId);
  if (!!cur?.phiAllowed === on) return true;
  const next = store.data.keys.find((k) => k.provider === chat.provider && k.phiAllowed === on);
  const note = next
    ? `PHI mode ${on ? "on" : "off"} — switched to key "${next.name}"${reason ? ` (${reason})` : ""}.`
    : `No ${on ? "PHI-approved" : "non-PHI"} ${chat.provider} key configured — add one in Settings.`;
  if (next) chat.keyId = next.id;
  chat.messages.push({ id: randomUUID(), role: "system", blocks: [{ type: "text", text: note }], ts: Date.now() });
  return !!next;
}

// copy uploads into the worktree so the agent can Read them; keep them out of git
function stageFiles(cwd: string, files: string[]) {
  if (!files.length) return [];
  const dir = join(cwd, ".consort", "uploads");
  mkdirSync(dir, { recursive: true });
  try {
    // worktrees share the main repo's info/exclude; ask git where it is
    const ex = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { cwd }).toString().trim();
    let cur = ""; try { cur = readFileSync(ex, "utf8"); } catch {}
    if (!cur.includes(".consort/")) appendFileSync(ex, "\n.consort/\n");
  } catch {}
  return files.map((f) => { const dest = join(dir, basename(f)); copyFileSync(f, dest); return dest; });
}

const running = new Map<string, AbortController>();
const pending = new Map<string, (allow: boolean) => void>();
let askPermission: (r: PermissionRequest) => void = () => {};
export const onPermission = (cb: typeof askPermission) => (askPermission = cb);
export const answerPermission = (id: string, allow: boolean) => pending.get(id)?.(allow);

export function stop(chatId: string) {
  running.get(chatId)?.abort();
}

export async function send(chatId: string, text: string, files: string[] = []) {
  const chat = store.chat(chatId);
  if (chat.running) throw new Error("chat is busy");
  const cwd = store.data.worktrees.find((w) => w.id === chat.worktreeId)!.path;
  const reason = phiSuspect(text, files);
  if (reason && !keyAllowsPhi(chat)) setPhiMode(chat, true, reason);
  const apiKey = store.getSecret(chat.keyId);
  const staged = stageFiles(cwd, files);
  const shown = staged.length ? `${text}\n\n${staged.map((f) => `📎 ${basename(f)}`).join("\n")}` : text;
  if (staged.length) text = `${text}\n\nAttached files (read them from disk):\n${staged.map((f) => `- ${f}`).join("\n")}`;
  chat.messages.push({ id: randomUUID(), role: "user", blocks: [{ type: "text", text: shown }], ts: Date.now() });
  chat.unreadCompletion = false;
  chat.running = true;
  chat.error = undefined;
  if (chat.phase === "waiting" || chat.phase === "complete") chat.phase = "planning";
  store.save();

  const ac = new AbortController();
  running.set(chatId, ac);
  const ui = new Transcript(chat);
  try {
    if (chat.provider === "claude") await runClaude(chat, cwd, apiKey, text, ac, ui);
    else await runCodex(chat, cwd, apiKey, text, ac, ui);
  } catch (e) {
    if (!ac.signal.aborted) chat.error = String((e as Error).message ?? e);
  } finally {
    running.delete(chatId);
    chat.running = false;
    chat.permissions = [];
    if (!ac.signal.aborted && !chat.error && (chat.phase as Phase) !== "waiting") {
      chat.phase = "complete";
      chat.unreadCompletion = true;
    } else if (ac.signal.aborted) chat.phase = "waiting";
    store.save();
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
      for (const m of b.text.matchAll(MARKER)) this.chat.phase = m[1] as Phase;
      if (b.text.includes("[phi-required]")) this.switchToPhiKey();
      b.text = b.text.replace(MARKER, "").replace(PHI_MARKER, "");
    }
    const m = this.assistant();
    m.blocks = m.blocks.filter((b) => b.type !== "text" || b.text.trim());
    this.flush(true);
  }
  private switchToPhiKey() {
    if (setPhiMode(this.chat, true, "agent flagged PHI")) this.msg = undefined;
  }
  flush(now = false) {
    if (now) {
      clearTimeout(this.timer);
      this.timer = undefined;
      store.save();
    } else if (!this.timer) this.timer = setTimeout(() => this.flush(true), 80);
  }
}

async function runClaude(chat: Chat, cwd: string, apiKey: string, text: string, ac: AbortController, ui: Transcript) {
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
      env: { ...envWithout("ANTHROPIC_API_KEY"), ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}) },
      permissionMode: chat.autoApprove ? "bypassPermissions" : "acceptEdits",
      allowDangerouslySkipPermissions: chat.autoApprove,
      canUseTool: async (tool, input) => {
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
          pending.set(id, finish);
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
      if (m.subtype !== "success") chat.error = (m as any).errors?.join("\n") || m.subtype;
      ui.finalizeText();
    }
  }
}

async function runCodex(chat: Chat, cwd: string, apiKey: string, text: string, ac: AbortController, ui: Transcript) {
  const codex = new Codex(apiKey ? { apiKey } : { env: envWithout("OPENAI_API_KEY") as Record<string, string> });
  const opts = { ...(chat.model ? { model: chat.model } : {}), workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode: "workspace-write" as const, approvalPolicy: "never" as const };
  const thread = chat.sessionId ? codex.resumeThread(chat.sessionId, opts) : codex.startThread(opts);
  const prompt = chat.sessionId ? text : `${PHASE_PROMPT}\n\n${phiPrompt(keyAllowsPhi(chat))}\n\n${text}`;
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
      else if (it.type === "error") chat.error = it.message;
    } else if (ev.type === "turn.failed") chat.error = ev.error.message;
    else if (ev.type === "error") chat.error = ev.message;
  }
  ui.finalizeText();
}

const envWithout = (k: string) => { const { [k]: _drop, ...rest } = process.env; return rest; };
const keyAllowsPhi = (chat: Chat) => !!store.data.keys.find((k) => k.id === chat.keyId)?.phiAllowed;
const pretty = (json: string) => {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
};
const flatten = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x?.type === "text" ? x.text : "")).join("\n") : "";
