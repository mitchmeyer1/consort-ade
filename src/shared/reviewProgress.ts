/**
 * A PR review is our own skill, so its shape is known: scope the PR, map the flows,
 * dispatch one agent per group of related files, verify the candidates, write the document.
 * This reads that shape back out of the transcript's tool calls so a running review
 * shows real progress instead of a single "executing".
 */
import type { Chat, Stage, StageState } from "./types";

type Tool = { name: string; input: string; output?: string; ok?: boolean };

const AGENT_TOOLS = ["task", "agent"];
const text = (t: Tool) => `${t.input}\n${t.output ?? ""}`;

/** Review chats are started from the pr-writeup skill, whose prompt carries its name */
export function isReviewChat(chat: Pick<Chat, "messages">) {
  return chat.messages.some((m) => m.role === "user" && m.blocks.some((b) => b.type === "text" && /pr-writeup/i.test(b.text)));
}

const tools = (chat: Pick<Chat, "messages">): Tool[] =>
  chat.messages.flatMap((m) => m.blocks).filter((b): b is Extract<typeof b, { type: "tool" }> => b.type === "tool")
    .map((b) => ({ name: b.name, input: b.input, output: b.output, ok: b.ok }));

/** the PR's changed-file count, straight from the listing the review takes its scope from */
function changedFiles(all: Tool[]) {
  let total = 0;
  for (const t of all) {
    if (!/--name-only/.test(t.input) || !t.output) continue;
    const lines = t.output.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("$") && /\.[\w]+$|\//.test(l));
    total = Math.max(total, lines.length);
  }
  return total;
}

export function reviewProgress(chat: Pick<Chat, "messages" | "running" | "phase">): Stage[] | null {
  if (!isReviewChat(chat)) return null;
  const all = tools(chat);
  const done = (t: Tool) => t.ok !== undefined;

  const scope = all.filter((t) => /gh pr (view|diff|checks)|pull\/\d+\/head/.test(t.input));
  const agents = all.filter((t) => AGENT_TOOLS.includes(t.name.toLowerCase()));
  // the shared brief (or the older coverage ledger) is written before any agent is dispatched
  const ledger = all.filter((t) => /pr-review\/brief\.md|pr-review-coverage\.md/.test(text(t)));
  // the review file is the deliverable now; older reviews wrote an HTML document
  const document = all.filter((t) => /\.review\.json|pr-writeup\.html/.test(text(t)));
  // after the last agent returns, the coordinator re-opens cited lines itself
  const lastAgent = agents.length ? all.lastIndexOf(agents[agents.length - 1]!) : -1;
  const afterAgents = lastAgent >= 0 ? all.slice(lastAgent + 1).filter((t) => /^(read|grep|glob|bash)$/i.test(t.name)) : [];

  const agentsDone = agents.filter(done).length;
  const files = changedFiles(all);
  const published = document.some((t) => done(t)) && !chat.running;

  const stage = (id: string, label: string, state: StageState, extra: Partial<Stage> = {}): Stage => ({ id, label, state, ...extra });
  const settled = (started: boolean, finished: boolean): StageState => finished ? "done" : started ? "active" : "pending";

  const stages: Stage[] = [
    stage("scope", "Scope the PR", settled(scope.length > 0 || all.length > 0, scope.some(done) && (agents.length > 0 || ledger.length > 0 || scope.filter(done).length > 1)), {
      detail: files ? `${files} changed file${files === 1 ? "" : "s"}` : undefined,
    }),
    stage("flows", "Map the flows", settled(scope.some(done), agents.length > 0 || ledger.length > 0)),
    stage("agents", "Review agents", settled(agents.length > 0, agents.length > 0 && agentsDone === agents.length && (afterAgents.length > 0 || document.length > 0 || !chat.running)), {
      // agents own groups of files, so the denominator is the agents dispatched, not the file count
      done: agentsDone,
      total: agents.length,
      detail: agents.length ? `${agentsDone}/${agents.length} agents back` : undefined,
    }),
    stage("verify", "Verify findings", settled(agents.some(done), document.length > 0)),
    stage("writeup", "Write the report", settled(document.length > 0, document.some(done))),
    stage("publish", "Publish", settled(document.some(done), published)),
  ];

  // only one stage can be the live one: the earliest unfinished stage that has started
  const active = stages.findIndex((s) => s.state === "active");
  return stages.map((s, i) => (s.state === "active" && i !== active ? { ...s, state: "pending" } : s));
}
