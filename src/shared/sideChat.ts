/**
 * Side chat: a read-only second agent you can ask about a long-running job
 * ("how far along is this?") without interrupting the agent doing the work.
 */

export type SideMessage = { id: string; role: "user" | "assistant"; text: string; ts: number };

export type SideSnapshot = {
  name: string;
  provider: string;
  model: string;
  phase: string;
  steps?: 3 | 5;
  running: boolean;
  /** how long the current (or last) run has been going */
  elapsedMs?: number;
  toolCalls: number;
  failedTools: number;
  queued: number;
  error?: string;
  /** compact transcript of the job so far, tool calls included */
  digest: string;
  /** files the job has written under .consort, newest first */
  files: string[];
  /** git status --short in the worktree */
  gitStatus: string;
  /** the /ship pipeline state when the job's worktree is a feature (shipStatusSummary) */
  ship?: string;
};

/** "1h 12m", "45s" — long jobs are the point, so hours read first */
export function elapsed(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const FILE_LIMIT = 40;

export const SIDE_SYSTEM = [
  "You are a side observer attached to a long-running agent job in this worktree.",
  "The user is checking in on that job while it works. Answer only about its state and progress.",
  "You are read-only: never edit, create or delete files, never run commands that change anything, and never message the working agent.",
  "Read the job's notes and the files it has written when that helps you answer.",
  "Answer in a few sentences. When asked how far along it is, give a percentage or fraction with the reasoning in one line — name what is done, what is in flight, and what is left. Say plainly when the transcript does not support an estimate rather than inventing one.",
].join(" ");

export function sideChatPrompt(snapshot: SideSnapshot, question: string, history: SideMessage[] = []) {
  const state = [
    `Job: ${snapshot.name}`,
    `Agent: ${snapshot.provider} · ${snapshot.model}`,
    `Status: ${snapshot.running ? "running now" : "not running"} · phase ${snapshot.phase}${snapshot.steps ? ` of ${snapshot.steps}` : ""}`,
    snapshot.elapsedMs !== undefined ? `Time on this run: ${elapsed(snapshot.elapsedMs)}` : "",
    `Tool calls so far: ${snapshot.toolCalls}${snapshot.failedTools ? ` (${snapshot.failedTools} failed)` : ""}`,
    snapshot.queued ? `Queued messages waiting: ${snapshot.queued}` : "",
    snapshot.error ? `Last run error: ${snapshot.error}` : "",
  ].filter(Boolean).join("\n");

  const files = snapshot.files.length
    ? `Files the job has written (read them if useful):\n${snapshot.files.slice(0, FILE_LIMIT).map((f) => `- ${f}`).join("\n")}`
    : "The job has not written any files under .consort yet.";

  const earlier = history.length
    ? `\n\nEarlier in this side chat:\n${history.map((m) => `${m.role === "user" ? "You were asked" : "You answered"}: ${m.text}`).join("\n")}`
    : "";

  return [
    SIDE_SYSTEM,
    `## The job right now\n${state}`,
    ...(snapshot.ship ? [`## The /ship pipeline this job belongs to\n${snapshot.ship}`] : []),
    `## Working tree (git status --short)\n${snapshot.gitStatus.trim() || "(clean)"}`,
    `## ${files}`,
    `## The job's transcript so far\n${snapshot.digest || "(nothing yet)"}`,
    `${earlier}\n\n## The user's question\n${question}`,
  ].join("\n\n");
}
