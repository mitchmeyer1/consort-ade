/**
 * General chats have no fixed script, so the agent declares its own: a `[plan: …|…|…]`
 * at the start of a task and `[step:N]` as it moves. This turns that into the same
 * progress rows a review gets, with any agents it fans out attributed to the live step.
 */
import type { Chat, ChatPlan, Stage, StageState } from "./types";

export const PLAN_MARKER = /\[plan:([^\]]{0,400})\]\s*/gi;
export const STEP_MARKER = /\[step:(\d{1,2})\]\s*/gi;

const MAX_STEPS = 8;
const MAX_LABEL = 48;
const AGENT_TOOLS = ["task", "agent"];
const SHOWN_SUBTASKS = 4;

/** a last step that actually proves the work: tests, a browser check, running the thing */
const VERIFIES = /\b(verif|test|check|confirm|validat|screenshot|prove|qa|lint|typecheck|type-check|run the|exercise|smoke)/i;
export const VERIFY_STEP = "Verify the result";

export const isVerifyStep = (label: string) => VERIFIES.test(label);

/** every plan ends by checking its own work, whether or not the agent remembered to say so */
export function withVerifyStep(steps: string[]) {
  const last = steps[steps.length - 1];
  return last && isVerifyStep(last) ? steps : [...steps.slice(0, MAX_STEPS - 1), VERIFY_STEP];
}

const tidy = (label: string) =>
  label.trim().replace(/\s+/g, " ").replace(/^[-–—*\d.)\s]+/, "").slice(0, MAX_LABEL).trim();

/** "[plan: read the code | change it | test it]" → the steps, ignoring blanks and overlong lists */
export function parsePlan(raw: string): string[] {
  const steps = raw.split(/[|;]/).map(tidy).filter(Boolean);
  return steps.length >= 2 ? withVerifyStep(steps.slice(0, MAX_STEPS)) : [];
}

/** apply a `[plan:…]`: a new plan replaces the old one, since it belongs to the new task */
export const startPlan = (steps: string[], now: number): ChatPlan =>
  ({ steps: steps.map((label, i) => ({ label, ...(i === 0 ? { startedAt: now } : {}) })), current: 0, ts: now });

/** apply a `[step:N]` (1-based): everything before it is finished, it is now live */
export function advancePlan(plan: ChatPlan, step: number, now: number): ChatPlan {
  const current = Math.max(0, Math.min(step - 1, plan.steps.length - 1));
  if (current < plan.current) return plan; // agents count up; a stray lower marker is noise
  return {
    ...plan,
    current,
    steps: plan.steps.map((s, i) => i < current ? { ...s, startedAt: s.startedAt ?? now, doneAt: s.doneAt ?? now }
      : i === current ? { ...s, startedAt: s.startedAt ?? now, doneAt: undefined } : s),
  };
}

/**
 * The run ended. Steps it actually reached are done; steps it never started are marked
 * skipped rather than quietly ticked — a plan that ends without its verification step
 * should say so instead of claiming the work was checked.
 */
export const finishPlan = (plan: ChatPlan, now: number): ChatPlan =>
  ({ ...plan, steps: plan.steps.map((s, i) => i <= plan.current || s.startedAt !== undefined
    ? { ...s, startedAt: s.startedAt ?? now, doneAt: s.doneAt ?? now }
    : { ...s, skipped: true }) });

export function planStages(chat: Pick<Chat, "messages" | "running" | "plan">): Stage[] | null {
  const plan = chat.plan;
  if (!plan?.steps.length) return null;
  // sub-agents belong to whichever step was live when their message arrived
  const dispatched = chat.messages.flatMap((m) => m.blocks
    .filter((b) => b.type === "tool" && AGENT_TOOLS.includes(b.name.toLowerCase()))
    .map((b) => ({ ts: m.ts, label: subtaskLabel(b as Extract<typeof b, { type: "tool" }>), done: (b as { ok?: boolean }).ok !== undefined })));

  return plan.steps.map((step, i) => {
    const state: StageState = step.skipped ? "skipped"
      : step.doneAt ? "done"
      : i === plan.current && (chat.running || i > 0) ? "active"
      : i < plan.current ? "done" : "pending";
    const next = plan.steps.slice(i + 1).find((s) => s.startedAt)?.startedAt;
    const mine = step.startedAt === undefined ? [] : dispatched.filter((d) => d.ts >= step.startedAt! && (next === undefined || d.ts < next));
    if (!mine.length) return { id: `step-${i}`, label: step.label, state };
    const back = mine.filter((d) => d.done).length;
    return {
      id: `step-${i}`,
      label: step.label,
      state,
      done: back,
      total: mine.length,
      detail: `${back}/${mine.length} agent${mine.length === 1 ? "" : "s"} back`,
      subtasks: mine.slice(0, SHOWN_SUBTASKS).map((d) => ({ label: d.label, state: d.done ? "done" as const : "active" as const })),
    };
  });
}

/** what a dispatched agent is working on, from its prompt's first meaningful line */
function subtaskLabel(block: { input: string }) {
  let text = block.input;
  try {
    const parsed = JSON.parse(block.input);
    text = parsed.description ?? parsed.prompt ?? parsed.task ?? text;
  } catch {}
  return tidy(String(text).split("\n").find((l) => l.trim()) ?? "agent") || "agent";
}
