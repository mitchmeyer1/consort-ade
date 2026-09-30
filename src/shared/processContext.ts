import type { ChatPlan } from "./types";

/**
 * What a resumed turn is told about the multi-step process it was in the middle of, so it picks
 * up at the same step instead of starting a new plan. The feature checklist and a PR review
 * carry their own reminders; this covers the per-task plan. /ship re-attaches its stage prompt.
 */
export function planReminder(plan: ChatPlan | undefined): string {
  if (!plan?.steps.length) return "";
  const open = plan.steps.some((s) => !s.doneAt && !s.skipped);
  if (!open) return "";
  const lines = plan.steps.map((s, i) => `${i + 1}. [${s.doneAt ? "x" : s.skipped ? "-" : i === plan.current ? ">" : " "}] ${s.label}`);
  const at = plan.steps[plan.current];
  return `You were partway through this plan (x done, > in progress):\n${lines.join("\n")}\nDo not redeclare it. Continue from step ${plan.current + 1}${at ? ` (${at.label})` : ""}: emit [plan: ${plan.steps.map((s) => s.label).join(" | ")}] once, then [step:${plan.current + 1}] and carry on, ticking the rest as you go.`;
}
