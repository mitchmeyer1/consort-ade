/** One live overview; ticket titles lead to the existing discussion threads. */
import { ago, costCell, FINISHED, recentCompleted, taskHealth, taskStep, visibleTasks } from './headless.ts';
import { sentryAnalysisRow } from './sentryProgress.ts';
import type { CliState } from '../cli/state.ts';
import type { ConnectorUsage } from './usage.ts';
export const MASTER_MONITOR_HEADING = '*📊 Consort master monitor*';
const clean = (s: string, length = 160) => s.replace(/[\r\n\t]+/g, ' ').replace(/[*_`~]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, length);
const linked = (label: string, url?: string) => url && /^https:\/\/[^\s<>|]+$/.test(url) ? `<${url}|${clean(label, 65)}>` : clean(label, 65);
export function slackMasterMonitor(state: CliState, threads: Map<string, string>, now: number, alive: (pid: number) => boolean, usage = new Map<string, ConnectorUsage>()): string {
  const tasks = visibleTasks(state.tasks, now).sort((a,b) => b.updatedAt - a.updatedAt);
  const completed = recentCompleted(tasks);
  const working = tasks.filter(t => !completed.includes(t));
  const lines = [MASTER_MONITOR_HEADING, `Updated ${new Date(Math.floor(now / 60_000) * 60_000).toISOString().replace('T', ' ').slice(0,16)} UTC`, '', '*Working*'];
  const taskRow = (t: typeof tasks[number], detail: boolean) => {
    const health = taskHealth(t, state.accounts, { workerAlive: !!t.pid && alive(t.pid), logAgeMs: now - t.updatedAt }, now);
    const step = taskStep(t);
    const status = health.label;
    const icon = status === 'WAITING' || status === 'STOPPED' ? '❌' : FINISHED.includes(t.status) ? '🎉🍭🎊' : '🔄';
    const age = t.finishedAt ? `finished ${ago(now-t.finishedAt)} ago` : ago(now-t.startedAt);
    const title = `${t.slackIdentity?.emoji ?? ''} ${t.slackIdentity?.title ?? t.ticket.title}`.trim();
    const destinations = [t.ticket.url ? linked('ticket',t.ticket.url) : '', t.review?.url ?? t.feature?.prs?.at(-1) ? linked('github', t.review?.url ?? t.feature.prs.at(-1)) : ''].filter(Boolean);
    lines.push(`${icon} ${linked(title,threads.get(t.id))}${threads.has(t.id)?'':' (Slack thread pending)'} · ${clean(status)} · ${clean(step.name)} ${step.n}/${step.total} · ${costCell(t.cost) || 'cost pending'} · ${age}`);
    if (detail) lines.push(`   ${clean(t.status === 'waiting' ? t.pauseReason ?? t.note ?? t.activity ?? health.note ?? 'Needs your Slack reply' : health.note ?? t.activity ?? t.note ?? 'Preparing the task', 200)}`);
    if (destinations.length) lines.push(`   ${destinations.join(' · ')}`);
  };
  const preparation = state.jobs.filter(j => !working.some(t=>t.jobId===`${j.id}-worker` && !FINISHED.includes(t.status))).flatMap(j=>{const row=sentryAnalysisRow(j,now,true);return row?[row]:[];});
  for (const row of preparation) lines.push(`🔄 ${clean(row.title,65)} · ${row.status} · ${row.stage} ${row.step}/3`, `   ${clean(row.action,200)}`);
  // Keep one post within Slack's text budget; links remain outside code blocks and clickable.
  for (const t of working.slice(0,16)) taskRow(t,true);
  if (working.length>16) lines.push(`… ${working.length-16} more tasks in the CLI`);
  if (!working.length && !preparation.length) lines.push('No tasks in progress.');
  lines.push('', '*Completed · most recent 6*');
  for(const t of completed) taskRow(t,false);
  if(!completed.length) lines.push('No completed tasks yet.');
  lines.push('', '*Accounts*');
  const providerCounts = new Map<string,number>();
  for(const a of state.accounts) {
    const number=(providerCounts.get(a.provider)??0)+1;providerCounts.set(a.provider,number);
    const cached=usage.get(a.id);
    const windows=cached?.windows.slice(0,4).map(w=>`${clean(w.label,20)} ${Math.round(w.percent)}%`).join(' · ');
    const blocked=a.blockedUntil && a.blockedUntil>now;
    const label=blocked ? `limited until ${new Date(a.blockedUntil!).toISOString().slice(11,16)} UTC` : 'available';
    lines.push(`${blocked?'❌':'✅'} ${a.provider==='claude'?'Claude':'Codex'} ${number} · ${label}${windows?` · ${windows}`:''}${cached?` · usage ${ago(now-cached.at)} ago`:''}`);
  }
  if(!state.accounts.length) lines.push('No accounts configured.');
  lines.push('', 'Open a ticket title to reply in its Slack thread. This monitor updates in place; ticket discussions stay in their own threads.', '', 'STATUS: MONITORING');
  return lines.join('\n');
}
