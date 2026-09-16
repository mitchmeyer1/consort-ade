import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { store } from "./store";

const run = promisify(execFile);

// "feat/stamp-hint-users-86ak5k9ke" -> "Stamp Hint Users"
export const humanize = (branch: string) =>
  branch.split("/").pop()!.replace(/-?\b[0-9a-z]*\d[0-9a-z]*\b/gi, "").replace(/[-_]+/g, " ").trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || branch;

// ponytail: one haiku call, falls back to the humanized branch when there's no key or it fails
export async function suggestTitle(path: string, branch: string): Promise<string> {
  const key = store.data.keys.find((k) => k.provider === "claude") ;
  const apiKey = (key && store.getSecret(key.id)) || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return humanize(branch);
  try {
    const { stdout } = await run("git", ["log", "-8", "--format=%s"], { cwd: path });
    const r = await new Anthropic({ apiKey }).messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 20,
      messages: [{ role: "user", content: `Branch: ${branch}\nRecent commits:\n${stdout}\n\nReply with only a 2-4 word Title Case name for this line of work. No punctuation, no ticket IDs.` }],
    });
    const t = r.content[0].type === "text" ? r.content[0].text.trim().replace(/["'.]/g, "") : "";
    return t && t.length <= 40 ? t : humanize(branch);
  } catch {
    return humanize(branch);
  }
}
