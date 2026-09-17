import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { store } from "./store";
import { askOnce } from "./namer";
import * as git from "./git";
import type { Block, Message } from "../shared/types";

const run = promisify(execFile);

// Transcript rows show a taste of each command's output, not the whole thing.
const MAX_LINES = 10;
const MAX_CHARS = 700;
function truncate(out: string) {
  const lines = out.trim().split("\n");
  let shown = lines.slice(0, MAX_LINES).join("\n");
  if (shown.length > MAX_CHARS) shown = shown.slice(0, MAX_CHARS) + "…";
  const hidden = lines.length - Math.min(lines.length, MAX_LINES);
  return hidden > 0 ? `${shown}\n… ${hidden} more line${hidden === 1 ? "" : "s"}` : shown;
}
const shq = (s: string) => (/^[\w./:@=-]+$/.test(s) ? s : JSON.stringify(s));

/**
 * The "commit" shortcut under the composer. Runs plain git in the chat's worktree and narrates it into
 * the transcript as assistant text + Bash tool rows, so it reads like the agent did it. No agent is involved:
 * the only model call is the one-shot commit message draft when the user didn't type one.
 */
export async function commitFromChat(chatId: string, message?: string): Promise<string> {
  const chat = store.data.chats.find((c) => c.id === chatId);
  if (!chat) throw new Error("Chat not found");
  if (chat.running) throw new Error("The agent is still working in this chat. Wait for it to finish before committing.");
  const wt = store.data.worktrees.find((w) => w.id === chat.worktreeId);
  if (!wt) throw new Error("Worktree not found");
  const cwd = wt.path;
  message = message?.trim() || undefined;

  chat.messages.push({ id: randomUUID(), role: "user", blocks: [{ type: "text", text: message ? `Commit and push:\n\n${message}` : "Commit and push." }], ts: Date.now() });
  const msg: Message = { id: randomUUID(), role: "assistant", blocks: [], ts: Date.now() };
  chat.messages.push(msg);
  chat.running = true; // tool rows spin and the composer shows "Working…" while git runs
  chat.unreadCompletion = false;
  store.save();

  const say = (t: string) => { msg.blocks.push({ type: "text", text: t }); store.save(); };
  const sh = async (args: string[], display?: string) => {
    const b: Extract<Block, { type: "tool" }> = { type: "tool", id: randomUUID(), name: "Bash", input: JSON.stringify({ command: display ?? `git ${args.map(shq).join(" ")}` }) };
    msg.blocks.push(b);
    store.save();
    try {
      const { stdout, stderr } = await run("git", args, { cwd, maxBuffer: 1 << 24 });
      const out = [stdout, stderr].filter((s) => s?.trim()).join("\n").trim();
      Object.assign(b, { output: out ? truncate(out) : "(no output)", ok: true });
      store.save();
      return out;
    } catch (e: any) {
      const out = String(e.stderr || e.stdout || e.message).trim();
      Object.assign(b, { output: truncate(out) || String(e.message), ok: false });
      store.save();
      throw new Error(out.split("\n").filter(Boolean).pop() || e.message);
    }
  };

  try {
    const status = await sh(["status", "--short"]);
    if (!status.trim()) { say("Nothing to commit. The working tree is clean."); return "clean"; }
    const n = status.split("\n").filter(Boolean).length;

    if (!message) {
      say(`${n} changed file${n === 1 ? "" : "s"}. Drafting a commit message from the diff…`);
      await sh(["diff", "--stat", "HEAD"]);
      const diff = await git.diffForSummary(cwd);
      message = await askOnce(cwd, `Write a git commit message for this diff.\nFormat: a short imperative subject line (max 60 chars), a blank line, then 1 to 4 bullets, each ONE sentence, each starting with "- ". No other text.\n\n${diff}`)
        .then((t) => t.replace(/^```[a-z]*\n?|```$/g, "").replace(/^["'`]+|["'`]+$/g, "").trim())
        .catch(() => "");
      if (!message) message = `Update ${n} file${n === 1 ? "" : "s"}`;
      say(`> ${message.split("\n").join("\n> ")}`);
    }

    await sh(["add", "-A"]);
    const subject = message.split("\n")[0];
    await sh(["commit", "-m", message], `git commit -m ${JSON.stringify(subject)}${message.includes("\n") ? " …" : ""}`);
    const hash = (await run("git", ["rev-parse", "--short", "HEAD"], { cwd })).stdout.trim();
    await sh(["push", "-u", "origin", "HEAD"]);
    const branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim();
    say(`Committed \`${hash}\` and pushed to \`${branch}\`.`);
    return `${hash} · pushed`;
  } catch (e: any) {
    say(`Stopped: ${e.message}`);
    throw e;
  } finally {
    chat.running = false;
    store.save();
  }
}
