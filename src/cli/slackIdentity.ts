/**
 * A task's Slack heading: one emoji and a short title, so threads tell apart at a glance. Picked
 * locally from the title's words (no model turn, works while every account is blocked), and never
 * the emoji another open task already shows. A review swaps in the one its overview turn picks.
 */
import { parseSlackIdentity, type SlackIdentity } from "../shared/headless.ts";
import { loadState, updateTask } from "./state";

/** first matching words win; specific topics before broad ones */
const TOPICS: [RegExp, string[]][] = [
  [/\bmaps?\b|location|geo|address/i, ["🗺️", "📍", "🧭"]],
  [/deploy|release|rollout|ship/i, ["🚀", "🛫"]],
  [/\bci\b|pipeline|workflow|github action|build/i, ["🚦", "🏗️", "⚙️"]],
  [/sidebar|nav|menu|link|header|footer/i, ["🧭", "🔗", "📑"]],
  [/\bdb\b|database|sql|postgres|migration|schema|table/i, ["🗄️", "🧱", "💾"]],
  [/admin/i, ["🛡️", "🎛️"]],
  [/security|permission|auth|login|token|secret/i, ["🔐", "🔑"]],
  [/search|synonym|index|query/i, ["🔍", "📖"]],
  [/curation|curate|collection|catalog/i, ["🗂️", "🧺"]],
  [/promo|discount|coupon|pricing|price|billing|payment|invoice/i, ["🏷️", "💳", "💰"]],
  [/email|mail|notification|notify|alert/i, ["📧", "🔔"]],
  [/slack|chat|message/i, ["💬"]],
  [/user|member|profile|account|roster/i, ["👤", "👥"]],
  [/schedul|calendar|appointment|date|time/i, ["📅", "⏰"]],
  [/report|dashboard|chart|metric|analytics|stats/i, ["📊", "📈"]],
  [/export|csv|download|import|upload|file/i, ["📤", "📥", "📁"]],
  [/image|photo|screenshot|media|video/i, ["🖼️", "🎞️"]],
  [/style|css|theme|design|layout|ui\b|frontend|page/i, ["🎨", "🖌️", "🪟"]],
  [/api|endpoint|graphql|webhook|backend/i, ["🔌", "📡"]],
  [/cache|perf|performance|speed|slow|fast/i, ["⚡", "🏎️"]],
  [/test|spec|e2e|coverage/i, ["🧪", "🔬"]],
  [/bug|fix|error|crash|broken|hotfix/i, ["🐛", "🩹"]],
  [/refactor|cleanup|clean up|retire|remove|deprecat|delete|chore/i, ["🧹", "🪓", "♻️"]],
  [/docs?\b|readme|runbook|guide/i, ["📝", "📚"]],
  [/depend|upgrade|bump|version|lockfile|package/i, ["📦", "⬆️"]],
  [/log|monitor|sentry|trace/i, ["🛰️", "📟"]],
  [/health|patient|clinic|care/i, ["🩺", "🏥"]],
  [/mobile|ios|android|app\b/i, ["📱"]],
];
/** when no word matches, or every matching emoji is taken: a fixed palette, picked by the title */
const PALETTE = ["🦊", "🐙", "🦉", "🐝", "🌵", "🍋", "🍄", "🪐", "🌊", "🔥", "🌈", "🎯", "🧩", "🎲", "🪁", "🛶", "🏔️", "🌻", "🐢", "🦄", "🍉", "🧊", "🪴", "🦜", "🐳", "🦋", "🍀", "🎈", "🪵", "🧲"];

const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.codePointAt(0)!) >>> 0, 7);

/** the title without "Review:" and a conventional-commit prefix like "chore(frontend):" */
export const plainTitle = (title: string) => title.replace(/<[^>]*>/g, "").replace(/[*_`\u0000-\u001f<>|]/g, "").replace(/^\s*review:\s*/i, "").replace(/^\s*\w+(?:\([^)]*\))?!?:\s*/, "").replace(/\s+/g, " ").trim();

export function slackIdentityFor(title: string, taken: Iterable<string> = []): SlackIdentity {
  const clean = plainTitle(title);
  const used = new Set(taken);
  const matched = TOPICS.filter(([re]) => re.test(title)).flatMap(([, e]) => e);
  const free = (list: string[]) => list.find((e) => !used.has(e));
  const start = hash(clean) % PALETTE.length;
  const emoji = free(matched) ?? free([...PALETTE.slice(start), ...PALETTE.slice(0, start)]) ?? matched[0] ?? PALETTE[start];
  // the heading allows 5 words (headless.ts parseSlackIdentity)
  const short = clean.split(" ").slice(0, 5).join(" ").slice(0, 60).replace(/[;,:.\-–]+$/, "") || "Task";
  return parseSlackIdentity(JSON.stringify({ emoji, title: short })) ?? { emoji, title: "Task" };
}

/** emojis the other open tasks show now */
export const takenEmojis = (taskId: string) => loadState().tasks.filter((t) => t.id !== taskId && t.status !== "done" && t.status !== "released" && t.slackIdentity).map((t) => t.slackIdentity!.emoji);

export async function ensureSlackIdentity(taskId: string): Promise<void> {
  const task = loadState().tasks.find(t => t.id === taskId);
  if (task && !task.slackIdentity) updateTask(taskId, { slackIdentity: slackIdentityFor(task.ticket.title, takenEmojis(taskId)) });
}
