/** The dashboard's Scanners rows: each scanner's kind, on or off, how often it scans, and how many tickets it may hold open at once. */
import type { CliState, Job, Task } from "./state";
import { openTaskLimit } from "./capacity";
import { sentryTicketLimit } from "./sentryCapacity";
import type { ScannerRow } from "../shared/slackMonitor.ts";
import { scannerCriteria } from "../shared/scannerCriteria.ts";

const open = (t: Task) => ["working", "waiting", "monitoring"].includes(t.status);
const KIND: Record<Job["source"], string> = { clickup: "ClickUp", sentry: "Sentry", review: "PR review", github: "GitHub" };

/** One row per scanner; a Sentry scanner's bundle worker is folded into its row rather than listed apart. */
export function scannerRows(state: Pick<CliState, "jobs" | "tasks">): ScannerRow[] {
  return state.jobs.filter((j) => !j.sentryProducerId).map((j) => {
    const sentry = j.source === "sentry";
    const ids = new Set([j.id, ...(sentry ? [`${j.id}-worker`] : [])]);
    return {
      name: j.name, kind: KIND[j.source] ?? j.source, criteria: scannerCriteria(j), on: j.enabled, everyMinutes: j.everyMinutes,
      open: state.tasks.filter((t) => ids.has(t.jobId) && open(t)).length,
      limit: sentry ? sentryTicketLimit(j) : openTaskLimit(j),
      turns: sentry ? sentryTicketLimit(j) : j.maxParallel,
      lastScanAt: j.lastScanAt,
    };
  });
}
