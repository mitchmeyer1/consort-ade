import type { CliModelRole } from "./cliModels.ts";

/** A task can ask for deeper reasoning without asking the owner to solve a code problem. */
export const MODEL_ROLE_RULES = (role: CliModelRole) => `## Model budget: ${role}
Do this bounded job using the supplied task artifacts and shared research. Do not dispatch additional agents: Consort schedules parallel work and applies capacity limits. A PR review that explicitly invokes the review skill may dispatch only its reserved foreground reader on the supplied reader model.
If uncertain cross-system behavior, security-sensitive reasoning, a conflicting business rule, or repeated failed checks requires deeper analysis, stop and emit [model-escalate: concrete reason] before changing behavior. Do not use this marker for an owner decision; ask the owner with [ask-user: ...] instead. On the frontier model, resolve the analysis or ask the owner only for a real decision. Preserve the impact check and never approve a broken business flow yourself.`;

export const parseModelEscalation = (text: string): string | undefined =>
  /\[model-escalate:\s*([^\]\n]+)\]/i.exec(text)?.[1]?.trim() || undefined;

/** A settled spec is implementation work even before its first stage transition. */
export function stageModelRole(stage: string, stalled = 0): CliModelRole {
  if (stalled >= 2) return "frontier";
  return ["Spec'd", "Implementing", "Ready to Test", "Revising"].includes(stage) ? "implementation" : "planning";
}
