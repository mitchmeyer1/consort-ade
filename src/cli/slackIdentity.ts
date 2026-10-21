/** A stable task heading costs no model turn and works while every account is blocked. */
import { parseSlackIdentity } from "../shared/headless.ts";
import { loadState, updateTask } from "./state";

export function slackIdentityFor(title: string): { emoji: string; title: string } {
  const clean = title.replace(/<[^>]*>/g, "").replace(/[*_`\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim();
  const short = (clean.length <= 60 ? clean : clean.split(" ").slice(0, 6).join(" ").slice(0, 60)) || "Task";
  const emoji = /map|location/i.test(clean) ? "🗺️" : /bug|fix|error/i.test(clean) ? "🐛" : /test/i.test(clean) ? "🧪" : /security|permission|auth/i.test(clean) ? "🔐" : "🛠️";
  return parseSlackIdentity(JSON.stringify({ emoji, title: short })) || { emoji: "🛠️", title: "Task" };
}

export async function ensureSlackIdentity(taskId: string): Promise<void> {
  const task = loadState().tasks.find(t => t.id === taskId);
  if (task && !task.slackIdentity) updateTask(taskId, { slackIdentity: slackIdentityFor(task.ticket.title) });
}
