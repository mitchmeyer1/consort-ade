import type { CliModelRole } from "./cliModels.ts";

/** A task can ask for deeper reasoning without asking the owner to solve a code problem. */
export const MODEL_ROLE_RULES = (role: CliModelRole) => `## Model budget: ${role}
Do this bounded job using the supplied task artifacts and shared research. Do not dispatch additional agents: Consort schedules parallel work and applies capacity limits. A PR review that explicitly invokes the review skill may dispatch only its reserved foreground reader on the supplied reader model.
If uncertain cross-system behavior, security-sensitive reasoning, a conflicting business rule, or repeated failed checks requires deeper analysis, stop and emit [model-escalate: concrete reason] before changing behavior. Do not use this marker for an owner decision; ask the owner with [ask-user: ...] instead. On the frontier model, resolve the analysis or ask the owner only for a real decision. Preserve the impact check and never approve a broken business flow yourself.`;

/** Asked only of Grilling-stage turns, which write the spec: the planner decides how hard the build should think, so the owner is never asked. */
export const BUILD_EFFORT_RULE = `When you write the spec, end with [build-effort: low|medium|high|xhigh|max — one-line reason]: the reasoning effort the build, its repairs and its evidence should run at. Weigh how much of the codebase the change touches, whether it crosses systems or includes a migration or unfamiliar code, how many stories the spec has, and what the impact check found. A routine change is medium; reserve xhigh and max for work where a wrong assumption is expensive.`;

export const parseBuildEffort = (text: string): { level: EffortLevel; reason?: string } | undefined => {
  const m = /\[build-effort:\s*(low|medium|high|xhigh|max)\b\s*(?:[—–:-]+\s*([^\]\n]+))?\]/i.exec(text);
  return m ? { level: m[1]!.toLowerCase() as EffortLevel, ...(m[2]?.trim() ? { reason: m[2].trim() } : {}) } : undefined;
};

export const parseModelEscalation = (text: string): string | undefined =>
  /\[model-escalate:\s*([^\]\n]+)\]/i.exec(text)?.[1]?.trim() || undefined;

/** A settled spec is implementation work even before its first stage transition. */
export function stageModelRole(stage: string, stalled = 0): CliModelRole {
  if (stalled >= 2) return "frontier";
  return ["Spec'd", "Implementing", "Ready to Test", "Revising"].includes(stage) ? "implementation" : "planning";
}

/** Reasoning effort by role: judgement gets more, bounded reading gets less. A scanner can set any role. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export type CliEffortPolicy = Partial<Record<CliModelRole, EffortLevel>>;
export const isEffortLevel = (value: string): value is EffortLevel => (EFFORT_LEVELS as readonly string[]).includes(value);
/** The build roles follow the planner's [build-effort]; readers and frontier turns are bounded jobs with their own levels. */
const PLANNED_ROLES: readonly CliModelRole[] = ["implementation", "coordination"];
/** Precedence: what the scanner pins, then what the planner decided for this task, then the role's default. */
export function roleEffort(role: CliModelRole, policy: CliEffortPolicy = {}, planned?: EffortLevel): EffortLevel {
  return policy[role] ?? (PLANNED_ROLES.includes(role) ? planned : undefined) ?? (role === "reader" ? "low" : role === "frontier" ? "high" : "medium");
}
/** Codex has no `max`; its top level is `xhigh`. */
export const codexEffort = (effort: EffortLevel): Exclude<EffortLevel, "max"> => (effort === "max" ? "xhigh" : effort);
