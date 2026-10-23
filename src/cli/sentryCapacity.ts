/** Sentry limits count whole bundle tickets, not just concurrent AI turns. */
import type { Job, Task } from "./state";
export function canClaimSentryTicket(job: Pick<Job, "sentryProducerId">, ticket: { sentryScannerId?: string }): boolean {
  return job.sentryProducerId ? ticket.sentryScannerId === job.sentryProducerId : !ticket.sentryScannerId;
}
export const sentryTicketLimit = (job: Job): number => Number.isInteger(job.maxParallel) && job.maxParallel > 0 ? job.maxParallel : 1;
export function sentryWorkerJob(producer: Job): Job {
  if (!producer.sentry) throw new Error("Missing Sentry routing configuration.");
  const limit = sentryTicketLimit(producer);
  return { ...producer, id: `${producer.id}-worker`, name: `${producer.name} bundles`, source: "clickup", sentry: undefined,
    sentryProducerId: producer.id, scope: { kind: "list", id: producer.sentry.listId }, listId: producer.sentry.listId,
    filters: { tags: [producer.sentry.tag], ...(producer.sentry.status ? { statuses: [producer.sentry.status] } : {}) },
    maxParallel: limit, maxOpenTasks: limit, maxEnvironments: limit, everyMinutes: 1,
  };
}
export function sentryOpenTickets(job: Job, tickets: any[], workers: (Pick<Task, "ticket" | "status"> & { jobId?: string })[] = []): number {
  const finished = new Set(workers.filter(t => ["ready", "done", "released"].includes(t.status)).map(t => t.ticket.id));
  const local = new Map(workers.map(t => [t.ticket.id, t.status]));
  const ids = new Set(workers.filter(t => t.jobId === `${job.id}-worker` && !["ready", "done", "released"].includes(t.status)).map(t => t.ticket.id));
  for (const ticket of tickets) {
    const text = `${ticket.description ?? ""}\n${ticket.markdown_description ?? ""}`;
    const owned = text.includes(`[consort-sentry-scanner:${job.id}]`);
    const legacy = text.includes("[consort-sentry-group:") && String(ticket.list?.id ?? job.sentry?.listId) === job.sentry?.listId;
    if ((!owned && !legacy) || finished.has(String(ticket.id)) || (!local.has(String(ticket.id)) && ["closed", "done"].includes(ticket.status?.type))) continue;
    ids.add(String(ticket.id));
  }
  return ids.size;
}
