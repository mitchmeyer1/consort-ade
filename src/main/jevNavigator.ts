export type JevCandidate = { id: string; description: string };
export type JevNavigatorState = {
  goal: string;
  currentStep: string;
  progress?: string[];
  screen?: unknown;
  lastResult?: string;
  candidates: JevCandidate[];
};

export type JevNavigatorDecision = {
  action: string;
  confidence: number;
  probabilities: Record<string, number>;
  escalate: boolean;
  model?: string;
  cost?: number;
};

export function validateNavigatorState(input: unknown): JevNavigatorState {
  const state = input as Partial<JevNavigatorState> | null;
  if (!state || typeof state.goal !== "string" || !state.goal.trim() || typeof state.currentStep !== "string" || !state.currentStep.trim()) throw new Error("Navigator state needs a goal and current step");
  if (!Array.isArray(state.candidates) || state.candidates.length < 2 || state.candidates.length > 50) throw new Error("Navigator state needs 2 to 50 candidate actions");
  const seen = new Set<string>();
  const candidates = state.candidates.map((candidate) => {
    const id = typeof candidate?.id === "string" ? candidate.id.trim() : "";
    const description = typeof candidate?.description === "string" ? candidate.description.trim() : "";
    if (!/^[a-z0-9][a-z0-9_.:-]{0,79}$/i.test(id) || seen.has(id) || !description || description.length > 500) throw new Error("Navigator candidates need unique safe ids and descriptions");
    seen.add(id);
    return { id, description };
  });
  return { goal: state.goal.trim(), currentStep: state.currentStep.trim(), progress: state.progress?.slice(0, 50).map(String), screen: state.screen, lastResult: state.lastResult?.slice(0, 2_000), candidates };
}

export async function chooseWithJev(apiKey: string, input: unknown, fetcher: typeof fetch = fetch, minimumConfidence = 0.75): Promise<JevNavigatorDecision> {
  if (!apiKey) throw new Error("Add an OpenRouter API key in Consort Settings to enable the Jev navigator");
  const state = validateNavigatorState(input);
  const response = await fetcher("https://openrouter.ai/api/alpha/decisions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://consort.local", "X-Title": "Consort Autopilot" },
    body: JSON.stringify({
      model: "~typesafe/jev-latest",
      state: { goal: state.goal, current_step: state.currentStep, progress: state.progress ?? [], screen: state.screen ?? null, last_result: state.lastResult ?? null },
      questions: {
        next_action: {
          type: "choice",
          instructions: "Choose the safest action that best advances `current_step` toward `goal` using only the observed `screen` and `last_result`. Choose escalate when the evidence is ambiguous or no action applies.",
          criteria: Object.fromEntries([...state.candidates.map((item) => [item.id, item.description]), ["escalate", "Stop and ask the supervising model because the state is ambiguous, unsafe, or outside the authorized actions."]]),
        },
      },
    }),
    signal: AbortSignal.timeout(12_000),
  });
  const result = await response.json() as any;
  if (!response.ok) throw new Error(result?.error?.message || result?.error || `OpenRouter returned ${response.status}`);
  const answer = result?.answers?.next_action;
  const action = typeof answer?.choice === "string" ? answer.choice : "escalate";
  const confidence = Number(answer?.confidence ?? 0);
  const valid = action === "escalate" || state.candidates.some((item) => item.id === action);
  const escalate = !valid || action === "escalate" || !Number.isFinite(confidence) || confidence < minimumConfidence;
  return { action: escalate ? "escalate" : action, confidence: Number.isFinite(confidence) ? confidence : 0, probabilities: answer?.probabilities && typeof answer.probabilities === "object" ? answer.probabilities : {}, escalate, model: result?.model, cost: result?.usage?.cost };
}
