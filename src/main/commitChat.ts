import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { store } from "./store";
import { askOnce } from "./namer";
import * as git from "./git";
import { isWorkspace, workspaceSources } from "../shared/workspace";
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

/** where git runs: the chat's worktree, or each repo of its workspace */
type Target = { cwd: string; label: string };

/**
 * The "commit" shortcut under the composer. Runs plain git in the chat's worktree and narrates it into
 * the transcript as assistant text + Bash tool rows, so it reads like the agent did it. No agent is involved:
 * the only model call is the one-shot commit message draft when the user didn't type one.
 * In a workspace the same message goes to every repo that has changes; clean repos are left alone.
 */
export async function commitFromChat(chatId: string, message?: string): Promise<string> {
  const chat = store.data.chats.find((c) => c.id === chatId);
  if (!chat) throw new Error("Chat not found");
  if (chat.running) throw new Error("The agent is still working in this chat. Wait for it to finish before committing.");
  const wt = store.data.worktrees.find((w) => w.id === chat.worktreeId);
  if (!wt) throw new Error("Worktree not found");
  const project = store.data.projects.find((p) => p.id === wt.projectId);
  const targets: Target[] = project && isWorkspace(project)
    ? workspaceSources(store.data, project).map(({ dir, path }) => ({ cwd: path, label: dir }))
    : [{ cwd: wt.path, label: "" }];
  message = message?.trim() || undefined;

  chat.messages.push({ id: randomUUID(), role: "user", blocks: [{ type: "text", text: message ? `Commit and push:\n\n${message}` : "Commit and push." }], ts: Date.now() });
  const msg: Message = { id: randomUUID(), role: "assistant", blocks: [], ts: Date.now() };
  chat.messages.push(msg);
  chat.running = true; // tool rows spin and the composer shows "Working…" while git runs
  chat.unreadCompletion = false;
  store.save();

  const say = (t: string) => { msg.blocks.push({ type: "text", text: t }); store.save(); };
  const sh = async (t: Target, args: string[], display?: string) => {
    const shown = display ?? `git ${args.map(shq).join(" ")}`;
    const b: Extract<Block, { type: "tool" }> = { type: "tool", id: randomUUID(), name: "Bash", input: JSON.stringify({ command: t.label ? `cd ${t.label} && ${shown}` : shown }) };
    msg.blocks.push(b);
    store.save();
    try {
      const { stdout, stderr } = await run("git", args, { cwd: t.cwd, maxBuffer: 1 << 24 });
      const out = [stdout, stderr].filter((s) => s?.trim()).join("\n").trim();
      Object.assign(b, { output: out ? truncate(out) : "(no output)", ok: true });
      store.save();
      return out;
    } catch (e: any) {
      const out = String(e.stderr || e.stdout || e.message).trim();
      Object.assign(b, { output: truncate(out) || String(e.message), ok: false });
      store.save();
      throw new Error(`${t.label ? `${t.label}: ` : ""}${out.split("\n").filter(Boolean).pop() || e.message}`);
    }
  };

  try {
    const dirty: (Target & { n: number })[] = [];
    for (const t of targets) {
      const status = await sh(t, ["status", "--short"]);
      const n = status.split("\n").filter(Boolean).length;
      if (n) dirty.push({ ...t, n });
    }
    if (!dirty.length) { say(targets.length > 1 ? "Nothing to commit. Every repo's working tree is clean." : "Nothing to commit. The working tree is clean."); return "clean"; }
    const total = dirty.reduce((s, t) => s + t.n, 0);

    if (!message) {
      const where = dirty.length > 1 ? ` across ${dirty.map((t) => t.label).join(", ")}` : dirty[0].label ? ` in ${dirty[0].label}` : "";
      say(`${total} changed file${total === 1 ? "" : "s"}${where}. Drafting a commit message from the diff…`);
      const diffs: string[] = [];
      for (const t of dirty) {
        await sh(t, ["diff", "--stat", "HEAD"]);
        const d = await git.diffForSummary(t.cwd);
        diffs.push(t.label ? `== ${t.label} ==\n${d}` : d);
      }
      message = await askOnce(dirty[0].cwd, `Write a git commit message for this diff.\nFormat: a short imperative subject line (max 60 chars), a blank line, then 1 to 4 bullets, each ONE sentence, each starting with "- ". No other text.\n\n${diffs.join("\n\n").slice(0, 14_000)}`)
        .then((t) => t.replace(/^```[a-z]*\n?|```$/g, "").replace(/^["'`]+|["'`]+$/g, "").trim())
        .catch(() => "");
      if (!message) message = `Update ${total} file${total === 1 ? "" : "s"}`;
      say(`> ${message.split("\n").join("\n> ")}`);
    }

    const subject = message.split("\n")[0];
    const done: string[] = [];
    let branch = "";
    for (const t of dirty) {
      await sh(t, ["add", "-A"]);
      await sh(t, ["commit", "-m", message], `git commit -m ${JSON.stringify(subject)}${message.includes("\n") ? " …" : ""}`);
      const hash = (await run("git", ["rev-parse", "--short", "HEAD"], { cwd: t.cwd })).stdout.trim();
      await sh(t, ["push", "-u", "origin", "HEAD"]);
      branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: t.cwd })).stdout.trim();
      done.push(t.label ? `${t.label} \`${hash}\`` : `\`${hash}\``);
    }
    say(`Committed ${done.join(", ")} and pushed to \`${branch}\`.`);
    return `${done.join(", ").replace(/`/g, "")} · pushed`;
  } catch (e: any) {
    say(`Stopped: ${e.message}`);
    throw e;
  } finally {
    chat.running = false;
    store.save();
  }
}
