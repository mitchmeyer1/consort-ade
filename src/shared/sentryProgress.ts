/** A dashboard-only preparation row: never a real task, claim, or agent slot. */
export type SentryScanProgress = {
  step: 1 | 2 | 3;
  action: string;
  at: number;
  error?: string;
  accountId?: string;
  model?: string;
};
export function sentryAnalysisRow(job: { id: string; name: string; source: string; enabled: boolean; scanStartedAt?: number; lastScanAt?: number; everyMinutes: number; scanProgress?: SentryScanProgress }, now: number, daemonRunning: boolean) {
  if (job.source !== 'sentry' || !job.enabled) return undefined;
  const p = job.scanProgress;
  const running = daemonRunning && !!job.scanStartedAt;
  const retryIn = Math.max(0, Math.ceil(((job.lastScanAt ?? 0) + job.everyMinutes * 60_000 - now) / 1000));
  const next = retryIn ? `next scan in ${Math.floor(retryIn / 60)}m ${retryIn % 60}s` : 'next scan due now';
  return {
    id: `sentry:${job.id.slice(-5)}`, title: job.name, running,
    step: p?.step ?? 1,
    stage: running ? ['Collect', 'Group', 'Create'][ (p?.step ?? 1) - 1 ] : p?.error ? 'Scan retry' : 'Scheduled',
    status: !daemonRunning ? 'STOPPED' : running ? 'RUNNING' : p?.error ? 'RETRY' : 'SCHEDULED',
    action: !daemonRunning ? 'Daemon stopped; start Consort to resume Sentry scans.' : running ? `${p?.action ?? 'Reading Sentry issues and checking existing ClickUp tickets'} · ClickUp ticket not created yet; no action needed from you` : `${p?.error ? `Last scan failed: ${p.error}. ` : p?.action ? `Last scan: ${p.action}. ` : ''}${next}. No action needed from you.`,
    accountId: running ? p?.accountId : undefined, model: running ? p?.model : undefined,
    ageMs: running ? now - job.scanStartedAt! : undefined,
  };
}
