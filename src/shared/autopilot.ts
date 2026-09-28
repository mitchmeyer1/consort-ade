export const AUTOPILOT_SUGGESTION_PROMPT = `When the user appears to be configuring or checking something in another desktop app and Autopilot would materially help, mention it briefly and end with exactly one actionable suggestion in this form: [followup: Execute with Autopilot | Turn on Autopilot and help me complete <specific task>.] Do not suggest Autopilot for work you can complete directly with code or APIs.`;

export type AutopilotAction =
  | { action: "observe" }
  | { action: "scan" }
  | { action: "activate"; app: string }
  | { action: "click"; x: number; y: number }
  | { action: "clickTarget"; target: string; generation: string }
  | { action: "type"; text: string }
  | { action: "key"; key: string };

export type AutopilotTarget = {
  id: string;
  source: "ocr";
  text: string;
  confidence: number;
  frame: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
};

export type AutopilotScan = {
  generation: string;
  capturedAt: number;
  screenshot: string;
  display: { id: number; x: number; y: number; width: number; height: number; scaleFactor: number };
  targets: AutopilotTarget[];
};

export type AutopilotPlanStep = {
  id: string;
  goal: string;
  app?: string;
  actions: string[];
  success: string;
  recover?: string[];
  maxAttempts?: number;
};

export type AutopilotPlan = {
  goal: string;
  successEvidence: string[];
  allowedApps: string[];
  confirmationActions: string[];
  steps: AutopilotPlanStep[];
};

export const APP_ACTION_LIBRARY = {
  Arc: { newTab: "cmd+t", focusLocation: "cmd+l", closeTab: "cmd+w", save: "cmd+s" },
  "Google Chrome": { newTab: "cmd+t", focusLocation: "cmd+l", closeTab: "cmd+w", save: "cmd+s" },
  Firefox: { newTab: "cmd+t", focusLocation: "cmd+l", closeTab: "cmd+w", save: "cmd+s" },
  Safari: { newTab: "cmd+t", focusLocation: "cmd+l", closeTab: "cmd+w", save: "cmd+s" },
} as const;

export function validateAutopilotPlan(input: unknown): AutopilotPlan {
  const plan = input as Partial<AutopilotPlan> | null;
  if (!plan || typeof plan.goal !== "string" || !plan.goal.trim()) throw new Error("Autopilot plan needs a goal");
  if (!Array.isArray(plan.successEvidence) || !plan.successEvidence.length) throw new Error("Autopilot plan needs success evidence");
  if (!Array.isArray(plan.allowedApps) || !plan.allowedApps.length) throw new Error("Autopilot plan needs allowed apps");
  if (!Array.isArray(plan.confirmationActions) || !Array.isArray(plan.steps) || !plan.steps.length) throw new Error("Autopilot plan needs confirmation rules and steps");
  const strings = (items: unknown[], label: string) => items.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 500) throw new Error(`Invalid ${label}`);
    return item.trim();
  });
  const ids = new Set<string>();
  const steps = plan.steps.map((raw, index) => {
    const step = raw as Partial<AutopilotPlanStep>;
    const id = typeof step.id === "string" ? step.id.trim() : "";
    if (!id || ids.has(id)) throw new Error(`Invalid or duplicate step id at ${index + 1}`);
    ids.add(id);
    if (typeof step.goal !== "string" || !step.goal.trim() || typeof step.success !== "string" || !step.success.trim()) throw new Error(`Step ${id} needs a goal and success condition`);
    if (!Array.isArray(step.actions) || !step.actions.length) throw new Error(`Step ${id} needs allowed actions`);
    const maxAttempts = step.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error(`Step ${id} has an invalid attempt limit`);
    return { id, goal: step.goal.trim(), app: step.app?.trim(), actions: strings(step.actions, "step action"), success: step.success.trim(), recover: step.recover ? strings(step.recover, "recovery action") : undefined, maxAttempts };
  });
  return {
    goal: plan.goal.trim(),
    successEvidence: strings(plan.successEvidence, "success evidence"),
    allowedApps: strings(plan.allowedApps, "allowed app"),
    confirmationActions: strings(plan.confirmationActions, "confirmation action"),
    steps,
  };
}

const keys = new Set(["return", "escape", "tab", "space", "delete", "left", "right", "up", "down", "cmd+a", "cmd+c", "cmd+v", "cmd+l", "cmd+s", "cmd+t", "cmd+w"]);

export function parseAutopilotAction(input: unknown): AutopilotAction {
  const value = input as Record<string, unknown> | null;
  if (!value || typeof value.action !== "string") throw new Error("An Autopilot action is required");
  if (value.action === "observe") return { action: "observe" };
  if (value.action === "scan") return { action: "scan" };
  if (value.action === "activate") {
    const app = typeof value.app === "string" ? value.app.trim() : "";
    if (!app || app.length > 120 || /[\r\n]/.test(app)) throw new Error("Use a valid application name");
    return { action: "activate", app };
  }
  if (value.action === "click") {
    const x = Number(value.x), y = Number(value.y);
    if (![x, y].every((n) => Number.isInteger(n) && n >= 0 && n <= 16_384)) throw new Error("Click coordinates must be integers from 0 to 16384");
    return { action: "click", x, y };
  }
  if (value.action === "clickTarget") {
    const target = typeof value.target === "string" ? value.target.trim() : "";
    const generation = typeof value.generation === "string" ? value.generation.trim() : "";
    if (!/^ocr-\d+$/.test(target) || !/^[a-f0-9-]{20,}$/i.test(generation)) throw new Error("Use a target and generation returned by scan");
    return { action: "clickTarget", target, generation };
  }
  if (value.action === "type") {
    const text = typeof value.text === "string" ? value.text : "";
    if (!text || text.length > 4_000) throw new Error("Type between 1 and 4000 characters");
    return { action: "type", text };
  }
  if (value.action === "key") {
    const key = typeof value.key === "string" ? value.key.toLowerCase() : "";
    if (!keys.has(key)) throw new Error(`Unsupported key: ${key || "(empty)"}`);
    return { action: "key", key };
  }
  throw new Error(`Unsupported Autopilot action: ${value.action}`);
}

export const AUTOPILOT_DRIVER_PROMPT = `Autopilot is enabled for this turn. You are the supervisor: first compile the whole task into a short control brief and bounded plan with the goal, success evidence, allowed apps, steps, allowed action names, recovery actions, and actions requiring user confirmation. Prefer known app shortcuts from the action library. Delegate repetitive navigation to the configured cheaper agent when available. The navigator should receive only the current step, progress, structured screen targets, and its authorized action choices. Use scan for local OCR targets and click-target with the returned target id and generation; never ask a navigator to invent coordinates. Use raw screenshots or a vision model only when structured targets are insufficient. Observe or scan at meaningful checkpoints and report uncertainty back instead of guessing. Never enter passwords, recovery codes, payment data, send/publish externally, purchase, delete, or change account/security settings without explicit confirmation immediately before that action. Keep control visible and stop when the success evidence is present.`;
