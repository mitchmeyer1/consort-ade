/**
 * The daemon answers the owner in each task's Slack thread even while the worker is busy, paused,
 * or finished. Every owner message, except the answer to a pending question and a bare "thanks",
 * goes to the oversight agent (cli/oversight.ts), which checks the logs, timings and worktree and
 * replies. When the message asks for a change, or carries files, it is also queued on the task as
 * an owner update for the worker to apply (cli/ownerUpdates.ts).
 */
import { brief, isTaskStatusQuestion, slackMessage, slackStatus, taskHealth, taskStep, type SlackTaskStatus } from "../shared/headless.ts";
import { loadState, updateTask, type CliState, type Task } from "./state";
import { Slack, type SlackThreadMessage } from "./slack";
import { taskSlackLinks } from "./slackLinks";
import { downloadSlackFiles, isAcknowledgement } from "./ownerUpdates";
import { answerOwner, workerLogTail, type OversightContext, type OversightAnswer } from "./oversight";
import { sourceFor } from "./sources";
import { stepLabel } from "./buildProgress";
import { existsSync } from "node:fs";

export type ResponderDeps = { answer: (c: OversightContext) => Promise<OversightAnswer> };

/** tasks whose thread is being answered now; the next poll skips them so replies stay in order */
const answering = new Map<string, Promise<void>>();
/** for tests: wait for every reply started so far */
export const settleOwnerReplies = () => Promise.all([...answering.values()]).then(() => {});

export async function answerTaskStatusQuestions(alive: (pid: number) => boolean, deps: ResponderDeps = { answer: answerOwner }): Promise<void> {
  const state = loadState();
  if (!state.slack) return;
  const slack = new Slack(state.slack);
  for (const task of state.tasks.filter(t => t.slackThread)) {
    if (answering.has(task.id)) continue;
    // Catch recent unanswered questions when an older daemon is upgraded.
    const afterTs = task.slackStatusAfterTs ?? String(Math.max(Number(task.slackThread), Date.now() / 1000 - 10 * 60));
    try {
      const messages = (await slack.threadMessages(task.slackThread!, afterTs))
        .filter(m => Number(m.ts) > Number(afterTs)).sort((a, b) => Number(a.ts) - Number(b.ts));
      if (!messages.length) { if (!task.slackStatusAfterTs) updateTask(task.id, { slackStatusAfterTs: afterTs }, false); continue; }
      // answering can take a minute or two; run it beside the poll so other threads are not held up
      answering.set(task.id, handleMessages(slack, task.id, messages, alive, deps)
        .catch(e => console.error(`Slack reply for ${task.ticket.id} failed; retrying: ${(e as Error).message}`))
        .finally(() => answering.delete(task.id)));
    } catch (e) { console.error(`Slack status check for ${task.ticket.id} failed; retrying: ${(e as Error).message}`); }
  }
}

async function handleMessages(slack: Slack, taskId: string, messages: SlackThreadMessage[], alive: (pid: number) => boolean, deps: ResponderDeps): Promise<void> {
  for (const message of messages) {
    const state = loadState();
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || !state.slack) return;
    if (!message.bot_id && message.user === state.slack.userId) await handleOwnerMessage(slack, state, task, message, alive, deps);
    updateTask(taskId, { slackStatusAfterTs: message.ts }, false);
  }
}

async function handleOwnerMessage(slack: Slack, state: CliState, task: Task, message: SlackThreadMessage, alive: (pid: number) => boolean, deps: ResponderDeps): Promise<void> {
  const text = (message.text ?? "").trim();
  const files = message.files ?? [];
  // the first owner message with text after a pending question is its answer (headless.ts replyAfter); the worker reads it
  const after = Number(task.pendingQuestion?.afterTs);
  const isAnswer = !!task.pendingQuestion && !!text && !isTaskStatusQuestion(text) && Number(message.ts) > after && !(task.answeredTs ?? []).some(ts => Number(ts) > after);
  if (isAnswer) updateTask(task.id, t => ({ answeredTs: [...(t.answeredTs ?? []), message.ts].slice(-20) }), false);
  const links = await taskSlackLinks(task, state.jobs.find(j => j.id === task.jobId)?.repo);
  if (isAnswer || (!files.length && isAcknowledgement(text))) {
    if (files.length) await post(slack, task, await queueOwnerUpdate(state.slack!.botToken, task.id, message, "(Files attached to the answer above; the answer itself was already applied.)", true) ?? "", links, alive);
    return;
  }
  let reply: OversightAnswer | undefined;
  try {
    reply = await deps.answer(await oversightContext(slack, state, task, text, alive));
  } catch (e) {
    console.error(`Oversight agent for ${task.ticket.id} failed: ${(e as Error).message}`);
  }
  // without the agent: the plain status line, and anything that is not a status question still reaches the worker
  const change = reply ? reply.update : isTaskStatusQuestion(text) ? undefined : text;
  const queued = files.length || change ? await queueOwnerUpdate(state.slack!.botToken, task.id, message, change && change !== text ? `${text}\n\n(Read as: ${change})` : text, false) : undefined;
  const body = reply?.answer || `${statusOf(loadState(), task.id, alive)?.line ?? ""}${reply ? "" : "\n• I could not check the details just now; ask again in a minute."}`;
  await post(slack, task, [body, queued].filter(Boolean).join("\n\n"), links, alive);
}

async function oversightContext(slack: Slack, state: CliState, task: Task, question: string, alive: (pid: number) => boolean): Promise<OversightContext> {
  const job = state.jobs.find(j => j.id === task.jobId);
  const thread = await slack.threadMessages(task.slackThread!, task.slackThread!).catch(() => [] as SlackThreadMessage[]);
  const ticketComments = job ? await sourceFor(job, state.clickupKey).comments(task.ticket.id).catch(() => []) : [];
  return {
    task, state, question, ticketComments,
    workerAlive: !!task.pid && alive(task.pid),
    thread: thread.sort((a, b) => Number(a.ts) - Number(b.ts)).map(m => ({ from: m.bot_id ? "bot" as const : m.user === state.slack?.userId ? "owner" as const : "other" as const, text: m.text ?? "", at: Math.round(Number(m.ts) * 1000) })),
    logTail: workerLogTail(task.id),
  };
}

function statusOf(state: CliState, taskId: string, alive: (pid: number) => boolean): { status: SlackTaskStatus; kind: Parameters<typeof slackMessage>[0]; line: string } | undefined {
  const current = state.tasks.find(t => t.id === taskId);
  if (!current) return undefined;
  const health = taskHealth(current, state.accounts, { workerAlive: !!current.pid && alive(current.pid), logAgeMs: Date.now() - current.updatedAt }, Date.now());
  const status: SlackTaskStatus = health.label === "COMPLETED" ? "COMPLETED" : health.label === "WAITING" ? "WAITING" : ["RUNNING", "STALLED", "LIMIT"].includes(health.label) ? "RUNNING" : "STOPPED";
  const step = taskStep(current);
  const action = status === "COMPLETED" ? "Ready for you to merge; Consort will not merge." : (current.status === "monitoring" ? current.activity ?? health.note : health.note ?? current.activity) ?? current.note ?? "Preparing the task.";
  return { status, kind: status === "COMPLETED" ? "completed" : status === "RUNNING" ? "update" : status === "WAITING" ? "waiting" : "stopped", line: `Step ${step.n}/${step.total} (${stepLabel(step.name, current.worktree)}): ${brief(action, 650).replace(/[.!?]+$/, "")}.` };
}

async function post(slack: Slack, task: Task, text: string, links: Awaited<ReturnType<typeof taskSlackLinks>>, alive: (pid: number) => boolean) {
  if (!text.trim()) return;
  const s = statusOf(loadState(), task.id, alive);
  await slack.post(slackStatus(slackMessage(s?.kind ?? "update", text.length > 2800 ? `${text.slice(0, 2797).trimEnd()}…` : text.trim()), s?.status ?? "RUNNING", links), task.slackThread);
}

const OPEN = ["working", "waiting", "monitoring"];

/** queue one owner message as an update; returns the line to add to the reply */
async function queueOwnerUpdate(token: string, taskId: string, message: SlackThreadMessage, text: string, filesOnly: boolean): Promise<string | undefined> {
  const task = loadState().tasks.find(t => t.id === taskId);
  if (!task) return undefined;
  const files = message.files ?? [];
  if (!OPEN.includes(task.status) && task.status !== "ready")
    return `This task is ${task.status === "done" ? `closed (${task.note ?? "PR closed"})` : task.status}, so I can't apply changes here. Post them on a new ticket.`;
  const saved = files.length && existsSync(task.worktree) ? await downloadSlackFiles(token, files, task.worktree, message.ts) : { saved: [], failed: files.map(f => `${f.name ?? "file"}: the task folder is not created yet`) };
  const update = { ts: message.ts, text, files: saved.saved, ...(saved.failed.length ? { failedFiles: saved.failed } : {}), at: Date.now() };
  const reopen = task.status === "ready";
  updateTask(taskId, t => ({ ownerUpdates: [...(t.ownerUpdates ?? []).filter(u => u.ts !== message.ts), update], ...(reopen ? { status: "monitoring", finishedAt: undefined, note: undefined, activity: "applying an owner update from Slack" } : {}) }), false);
  const when = task.pendingQuestion && !filesOnly ? " after you answer the question above" : reopen ? "; reopening the task" : " after the current step";
  const failed = saved.failed.length ? `\n• Could not download: ${saved.failed.join("; ")}` : "";
  const got = saved.saved.length ? `${saved.saved.length} file${saved.saved.length === 1 ? "" : "s"}` : "";
  return filesOnly ? `Saved ${got || "no files"}; I'll add ${saved.saved.length === 1 ? "it" : "them"} to the ticket${when}.${failed}` : `*Queued as a change${got ? ` with ${got}` : ""}:* I'll update the ticket and the code${when}.${failed}`;
}
