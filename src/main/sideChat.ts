import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";
import { store } from "./store";
import { loginEnv } from "./auth";
import { transcriptDigest } from "./agents";
import { cheapestModel, modelTiers } from "../shared/modelTiers";
import { SIDE_SYSTEM, sideChatPrompt, type SideMessage, type SideSnapshot } from "../shared/sideChat";
import type { Chat } from "../shared/types";

// keep the panel a check-in log, not a second transcript
const HISTORY = 20;
const DIGEST = 14_000;
// the observer only ever looks; nothing here can touch the job or the tree
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "NotebookRead", "TodoRead"];
const SIDE_MODEL: Record<Chat["provider"], (offered?: string[]) => string> = {
  claude: (offered) => cheapestModel(offered, "haiku"),
  codex: (offered) => modelTiers("codex", offered).delegate,
};

const sh = (cwd: string, cmd: string, args: string[]) =>
  new Promise<string>((res) => execFile(cmd, args, { cwd, maxBuffer: 1 << 22, timeout: 10_000 }, (_e, out) => res(out || "")));

async function snapshot(chat: Chat, cwd: string): Promise<SideSnapshot> {
  const [gitStatus, found] = await Promise.all([
    sh(cwd, "git", ["status", "--short"]),
    sh(cwd, "find", [".consort", "-type", "f", "-newermt", "-1 day"]),
  ]);
  const blocks = chat.messages.flatMap((m) => m.blocks);
  const lastUser = [...chat.messages].reverse().find((m) => m.role === "user");
  return {
    name: chat.name,
    provider: chat.provider,
    model: chat.model,
    phase: chat.phase,
    steps: chat.phaseSteps,
    running: chat.running,
    elapsedMs: lastUser ? Date.now() - lastUser.ts : undefined,
    toolCalls: blocks.filter((b) => b.type === "tool").length,
    failedTools: blocks.filter((b) => b.type === "tool" && b.ok === false).length,
    queued: chat.queuedMessages?.length ?? 0,
    error: chat.error,
    digest: transcriptDigest(chat, DIGEST),
    files: found.split("\n").filter(Boolean).slice(0, 60),
    gitStatus,
  };
}

const push = (chat: Chat, role: SideMessage["role"], text: string) => {
  chat.sideMessages = [...(chat.sideMessages ?? []), { id: randomUUID(), role, text, ts: Date.now() }].slice(-HISTORY * 2);
  store.save();
};

/** Ask a read-only observer about a chat's job. Runs beside the job; never interrupts it. */
export async function askSide(chatId: string, question: string) {
  const chat = store.chat(chatId);
  const cwd = store.data.worktrees.find((w) => w.id === chat.worktreeId)?.path;
  if (!cwd) throw new Error("This chat's worktree is gone.");
  if (chat.sideBusy) throw new Error("The side chat is still answering.");
  const key = store.data.keys.find((k) => k.id === chat.keyId);
  if (!key) throw new Error("This chat has no connector.");

  push(chat, "user", question);
  chat.sideBusy = true;
  store.save();
  try {
    const history = (chat.sideMessages ?? []).slice(0, -1).slice(-HISTORY);
    const prompt = sideChatPrompt(await snapshot(chat, cwd), question, history);
    const apiKey = store.getSecret(key.id);
    const answer = key.provider === "claude"
      ? await askClaude(cwd, prompt, apiKey, key, SIDE_MODEL.claude())
      : await askCodex(cwd, prompt, apiKey, key, SIDE_MODEL.codex(store.public().models?.codex));
    push(chat, "assistant", answer.trim() || "(no answer)");
  } catch (e) {
    push(chat, "assistant", `Couldn't answer: ${(e as Error).message ?? e}`);
  } finally {
    chat.sideBusy = false;
    store.save();
  }
}

type Key = NonNullable<ReturnType<typeof store.data.keys.find>>;

/** One read-only agent run in a worktree, on whichever provider the connector speaks. Returns the final text. */
export async function askReadOnly(cwd: string, prompt: string, key: Key, opts: { model: string; system: string; maxTurns?: number }) {
  const apiKey = store.getSecret(key.id);
  return key.provider === "claude"
    ? askClaude(cwd, prompt, apiKey, key, opts.model, opts.system, opts.maxTurns)
    : askCodex(cwd, prompt, apiKey, key, opts.model);
}
const envFor = (drop: string, key: Key, apiKey: string, set?: string) => {
  const { [drop]: _drop, ...rest } = process.env;
  return { ...rest, ...loginEnv(key), ...(apiKey && set ? { [set]: apiKey } : {}) } as Record<string, string>;
};

async function askClaude(cwd: string, prompt: string, apiKey: string, key: Key, model: string, system = SIDE_SYSTEM, maxTurns = 12) {
  let text = "";
  const q = query({
    prompt,
    options: {
      cwd,
      model,
      maxTurns,
      allowedTools: READ_ONLY_TOOLS,
      permissionMode: "bypassPermissions",
      env: envFor("ANTHROPIC_API_KEY", key, apiKey, "ANTHROPIC_API_KEY"),
      systemPrompt: { type: "preset", preset: "claude_code", append: system },
    },
  });
  for await (const m of q as AsyncIterable<any>) {
    if (m.type === "assistant") for (const b of m.message?.content ?? []) if (b.type === "text") text += b.text;
    if (m.type === "result" && m.subtype !== "success") throw new Error(m.errors?.join("\n") || m.subtype);
  }
  return text;
}

async function askCodex(cwd: string, prompt: string, apiKey: string, key: Key, model: string) {
  const codex = new Codex({ ...(apiKey ? { apiKey } : {}), env: envFor("OPENAI_API_KEY", key, apiKey, "OPENAI_API_KEY") });
  const thread = codex.startThread({ model, workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode: "read-only", networkAccessEnabled: false, approvalPolicy: "never" });
  const { events } = await thread.runStreamed(prompt);
  let text = "";
  for await (const ev of events as AsyncIterable<any>) {
    if (ev.type === "item.completed" && ev.item?.type === "agent_message") text = ev.item.text ?? text;
    else if (ev.type === "error") throw new Error(ev.message ?? "Codex error");
  }
  return text;
}
