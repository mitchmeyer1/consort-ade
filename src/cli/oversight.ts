/**
 * The oversight agent: answers the owner's messages in a task's Slack thread while the worker keeps
 * going. The daemon runs it, read-only, in the task's worktree with the worker log, turn timings,
 * task state, recent ticket comments and the thread so far. It answers, and flags a message that
 * also asks for a change so the daemon queues it as an owner update (cli/ownerUpdates.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { turnAccounts, turnPhi } from "../shared/phi.ts";
import { join } from "node:path";
import { seedModels, taskStep } from "../shared/headless.ts";
import { selectCliModel } from "../shared/cliModels.ts";
import type { Provider } from "../shared/types.ts";
import { runTurn as realRunTurn, type Turn, type TurnOptions } from "./agent";
import { usageFor } from "./usage";
import { modelLoad, type ConnectorUsage } from "../shared/usage.ts";
import { HOME, LOG_DIR, type Account, type CliState, type Task } from "./state";

export type OversightContext = {
  task: Task;
  state: CliState;
  question: string;
  workerAlive: boolean;
  /** recent thread messages, oldest first */
  thread: { from: "owner" | "bot" | "other"; text: string; at: number }[];
  /** recent comments on the ClickUp task or GitHub issue */
  ticketComments: { text: string; by?: string; at?: number }[];
  logTail?: string;
  now?: number;
};
export type OversightAnswer = { answer: string; update?: string; model: string };

const LOG_TAIL_BYTES = 14_000;
const TIMEOUT_MS = 4 * 60_000;

/** Opus on Claude, Sol on Codex: strong enough to read logs and code, not the top tier */
export function oversightModel(provider: Provider, policy?: CliState["jobs"][number]["modelPolicy"]): string {
  const configured = policy?.coordination?.[provider];
  if (configured) return configured;
  const models = seedModels()[provider];
  return provider === "claude" ? models.find((m) => /opus/.test(m)) ?? selectCliModel(provider, models, "implementation") : selectCliModel(provider, models, "implementation");
}

/** usable accounts, least used for the oversight model first on either provider (Claude breaks ties), then least recently used */
export const oversightAccounts = (accounts: Account[], now = Date.now(), usage = new Map<string, ConnectorUsage>(), policy?: CliState["jobs"][number]["modelPolicy"]) => {
  const load = (a: Account) => modelLoad(usage.get(a.id), oversightModel(a.provider, policy)) ?? 1_000;
  return accounts.filter((a) => !a.blockedUntil || a.blockedUntil <= now)
    .sort((a, b) => load(a) - load(b) || (a.provider === b.provider ? 0 : a.provider === "claude" ? -1 : 1) || (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
};

export function workerLogTail(taskId: string, bytes = LOG_TAIL_BYTES): string | undefined {
  try {
    const text = readFileSync(join(LOG_DIR, `${taskId}.log`), "utf8");
    return text.length > bytes ? text.slice(text.indexOf("\n", text.length - bytes) + 1) : text;
  } catch { return undefined; }
}

const clock = (at: number | undefined, now: number) => {
  if (!at) return "unknown time";
  const mins = Math.round((now - at) / 60_000);
  return `${new Date(at).toISOString()} (${mins < 1 ? "just now" : mins < 120 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`})`;
};

export function oversightPrompt(c: OversightContext): string {
  const now = c.now ?? Date.now();
  const t = c.task;
  const step = taskStep(t);
  const turns = (t.turnHistory ?? []).slice(-10).map((h) => `- ${clock(h.at, now)}: ${h.stage}, ${h.role} on ${h.model}, ${Math.round(h.durationMs / 60_000)} min${h.error ? `, error: ${h.error}` : ""}${h.escalated ? ", escalated" : ""}`);
  const active = (t.activeTurns ?? []).map((a) => `- started ${clock(a.startedAt, now)} (pid ${a.pid})`);
  const lines = [
    "You are the oversight agent for one Consort task. The task's worker agent is busy building it; you never change anything.",
    "The owner just wrote in the task's Slack thread. Answer them directly, the way a colleague who checked would.",
    "",
    "## How to answer",
    "- Check before you answer. Read the worker log below, then the worktree: .consort/ship/ (ticket, spec, tickets, progress), the code and tests, and git log / git diff where your tools allow. You are read-only.",
    "- Answer the actual question first, in one sentence. Then at most 5 short bullets with the evidence: file names, commit subjects, times, numbers.",
    "- Give real estimates when asked (\"about 60% done: 6 of 10 tickets landed\"), and say what they are based on.",
    "- If you cannot tell, say what you checked and what is unknown. Never invent progress.",
    "- Plain words, no headings, no preamble, under 180 words. Slack formatting: *bold*, `code`.",
    "- Never repeat a person's name, email, phone number, street address, date of birth or any patient detail, even if the ticket or data has them; say \"the patient\" or \"a user\". GitHub logins and Slack handles are fine.",
    "- If the owner asks for a change to the ticket, the spec or the code, or gives new requirements or feedback to act on (including \"go handle X's comments\"), end with one line: [queue-update: <the change, restated in one sentence>]. The worker will apply it after its current step. Do not add that line for pure questions.",
    ...(c.task.pendingQuestion ? ["- The worker is paused on the question listed under Task below, and this message is not the answer: the owner wants it clarified. Explain what is being asked, the options and what each would change, so they can decide. If the message reads like an answer phrased as a question, say what you understood and ask them to reply with it plainly."] : []),
    "",
    "## The owner's message",
    c.question.trim(),
    "",
    "## Task",
    `- Ticket: ${t.ticket.id} ${t.ticket.title} (${t.ticket.url})`,
    `- Worktree: ${t.worktree}, branch ${t.branch}`,
    `- Stage: ${t.feature.stage}; step ${step.n}/${step.total} (${step.name}); status ${t.status}${t.lifecycle ? `, ${t.lifecycle}` : ""}`,
    `- Worker process: ${c.workerAlive ? `running (pid ${t.pid})` : "not running"}`,
    `- Started ${clock(t.startedAt, now)}; last state change ${clock(t.updatedAt, now)}${t.lastPrCheckAt ? `; last PR check ${clock(t.lastPrCheckAt, now)}` : ""}`,
    `- Doing now: ${t.activity ?? "unknown"}`,
    ...(t.feature.prs.length ? [`- PRs: ${t.feature.prs.join(", ")}`] : []),
    `- Reviews done: ${t.reviewsDone}`,
    ...(t.pendingQuestion ? [`- Waiting on the owner for: ${t.pendingQuestion.questions.join(" | ")}`] : []),
    ...(t.ownerUpdates?.length ? [`- Owner updates queued, not yet applied: ${t.ownerUpdates.map((u) => JSON.stringify(u.text.slice(0, 200))).join("; ")}`] : []),
    ...(t.note ? [`- Note: ${t.note}`] : []),
    ...(t.recent?.length ? ["- Worker's latest progress lines, oldest first:", ...t.recent.map((r) => `  - ${r}`)] : []),
    ...(active.length ? ["", "## Agent turns running now", ...active] : []),
    ...(turns.length ? ["", "## Recent agent turns (finished)", ...turns] : []),
    ...(c.ticketComments.length ? ["", "## Recent ticket comments", ...c.ticketComments.slice(-10).map((m) => `- ${clock(m.at, now)}${m.by ? ` by ${m.by}` : ""}: ${m.text.replace(/\s+/g, " ").slice(0, 600)}`)] : []),
    ...(c.thread.length ? ["", "## Slack thread so far (latest last)", ...c.thread.slice(-14).map((m) => `- ${clock(m.at, now)} ${m.from}: ${m.text.replace(/\s+/g, " ").slice(0, 400)}`)] : []),
    "",
    "## Worker log (tail)",
    c.logTail ? "```\n" + c.logTail + "\n```" : "(no log found)",
  ];
  return lines.join("\n");
}

export function parseOversight(text: string): { answer: string; update?: string } {
  const update = /\[queue-update:\s*([\s\S]*?)\]\s*$/m.exec(text)?.[1]?.trim();
  const answer = text.replace(/\[queue-update:[\s\S]*?\]\s*$/m, "").trim();
  return { answer, ...(update ? { update } : {}) };
}

/** Run the oversight agent on the first usable account; a limit or failure moves to the next. */
export async function answerOwner(c: OversightContext, runTurn: (o: TurnOptions) => Promise<Turn> = realRunTurn, getUsage: (accounts: Account[]) => Promise<Map<string, ConnectorUsage>> = (a) => usageFor(a)): Promise<OversightAnswer> {
  const job = c.state.jobs.find((j) => j.id === c.task.jobId);
  const errors: string[] = [];
  const accounts = turnAccounts(c.state);
  const usable = accounts.filter((a) => !a.blockedUntil || a.blockedUntil <= (c.now ?? Date.now()));
  const usage = await getUsage(usable).catch(() => new Map<string, ConnectorUsage>());
  for (const account of oversightAccounts(accounts, c.now, usage, job?.modelPolicy)) {
    const model = oversightModel(account.provider, job?.modelPolicy);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      const turn = await runTurn({ phi: turnPhi(c.state), trace: { taskId: c.task.id, ticket: c.task.ticket.id, title: c.task.ticket.title, scanner: job?.name, kind: "oversight", stage: c.task.feature.stage, step: "answer the owner", role: "oversight" }, cwd: existsSync(c.task.worktree) ? c.task.worktree : job?.repo ?? HOME, prompt: oversightPrompt(c), model, account, readOnly: true, maxTurns: 25, effort: "medium", maxDelegates: 0, signal: abort.signal });
      if (turn.limit || turn.error || !turn.text.trim()) { errors.push(`${account.name}: ${turn.error ?? (turn.limit ? "usage limit" : "empty reply")}`); continue; }
      return { ...parseOversight(turn.text), model };
    } catch (e) { errors.push(`${account.name}: ${(e as Error).message}`); }
    finally { clearTimeout(timer); }
  }
  throw new Error(errors.length ? errors.join("; ") : "no usable AI account");
}
