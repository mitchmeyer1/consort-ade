/** One live overview; ticket titles lead to the existing discussion threads. */
import { ago, costCell, FINISHED, recentCompleted, taskHealth, taskStep, visibleTasks } from './headless.ts';
import { sentryAnalysisRow } from './sentryProgress.ts';
import type { CliState } from '../cli/state.ts';
import type { ConnectorUsage } from './usage.ts';
export const MASTER_MONITOR_HEADING = '*📊 Consort master monitor*';
const clean = (s: string, length = 160) => s.replace(/[\r\n\t]+/g, ' ').replace(/[*_`~]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, length);
const linked = (label: string, url?: string) => url && /^https:\/\/[^\s<>|]+$/.test(url) ? `<${url}|${clean(label, 65)}>` : clean(label, 65);
/** Ready work stays visible even when it is older than the six recent completions. */
export function slackMonitorGroups(state: Pick<CliState,'tasks'>, now: number) {
  const tasks=visibleTasks(state.tasks,now).sort((a,b)=>b.updatedAt-a.updatedAt);
  const ready=state.tasks.filter(t=>t.status==='ready').sort((a,b)=>b.updatedAt-a.updatedAt);
  const completed=recentCompleted(state.tasks.filter(t=>t.status!=='ready'));
  const working=tasks.filter(t=>!FINISHED.includes(t.status)||t.status==='failed');
  return {working,ready,completed};
}
export function slackMasterMonitor(state: CliState, threads: Map<string, string>, now: number, alive: (pid: number) => boolean, usage = new Map<string, ConnectorUsage>(), authors = new Map<string,string>()): string {
  const {working,ready,completed}=slackMonitorGroups(state,now);
  const lines = [MASTER_MONITOR_HEADING, `Updated ${new Date(Math.floor(now / 60_000) * 60_000).toISOString().replace('T', ' ').slice(0,16)} UTC`, '', '*Working*'];
  const taskRow = (t: CliState['tasks'][number], detail: boolean) => {
    const health = taskHealth(t, state.accounts, { workerAlive: !!t.pid && alive(t.pid), logAgeMs: now - t.updatedAt }, now);
    const step = taskStep(t);
    const status = t.status==='ready' ? 'READY TO MERGE' : health.label;
    const icon = t.status==='ready' ? '📦' : status === 'WAITING' ? '🟠' : status === 'STOPPED' ? '❌' : FINISHED.includes(t.status) ? '🎉🍭🎊' : '🔄';
    const age = t.status==='ready' ? `ready ${ago(now-(t.finishedAt??t.updatedAt))} ago` : t.finishedAt ? `finished ${ago(now-t.finishedAt)} ago` : ago(now-t.startedAt);
    const job = state.jobs.find(j=>j.id===t.jobId);
    const kind = t.kind==='review' ? 'Review' : job?.sentryProducerId || job?.source==='sentry' ? 'Sentry' : 'Feature';
    const author = authors.get(t.id) ?? t.review?.author;
    const pr = t.review?.url ?? t.feature?.prs?.at(-1);
    const byline = author ? `author: ${linked('@'+author, 'https://github.com/'+author)}` : pr ? 'author unavailable' : 'PR not created';
    const title = `${t.slackIdentity?.emoji ?? ''} ${t.slackIdentity?.title ?? t.ticket.title}`.trim();
    const destinations = [t.ticket.url ? linked('ticket',t.ticket.url) : '', t.review?.url ?? t.feature?.prs?.at(-1) ? linked(t.status==='ready'?'merge PR':'github', t.review?.url ?? t.feature.prs.at(-1)) : ''].filter(Boolean);
    lines.push(`${icon} ${kind} · ${linked(title,threads.get(t.id))}${threads.has(t.id)?'':' (Slack thread pending)'} · ${byline} · ${clean(status)} · ${clean(step.name)} ${step.n}/${step.total} · ${costCell(t.cost) || 'cost pending'} · ${age}`);
    if (detail) lines.push(`   ${clean(t.status === 'waiting' ? t.pauseReason ?? t.note ?? t.activity ?? health.note ?? 'Needs your Slack reply' : health.note ?? t.activity ?? t.note ?? 'Preparing the task', 200)}`);
    if (destinations.length) lines.push(`   ${destinations.join(' · ')}`);
  };
  const preparation = state.jobs.filter(j => !working.some(t=>t.jobId===`${j.id}-worker` && !FINISHED.includes(t.status))).flatMap(j=>{const row=sentryAnalysisRow(j,now,true);return row?[row]:[];});
  for (const row of preparation) lines.push(`🔄 Sentry · ${clean(row.title,65)} · ${row.status} · ${row.stage} ${row.step}/3`, `   ${clean(row.action,200)}`);
  // Keep one post within Slack's text budget; links remain outside code blocks and clickable.
  for (const t of working.slice(0,16)) taskRow(t,true);
  if (working.length>16) lines.push(`… ${working.length-16} more tasks in the CLI`);
  if (!working.length && !preparation.length) lines.push('No tasks in progress.');
  lines.push('', '*Ready to merge · your action*');
  for(const t of ready.slice(0,16)) taskRow(t,false);
  if(ready.length>16) lines.push(`… ${ready.length-16} more ready-to-merge tickets in the CLI`);
  if(!ready.length) lines.push('No tickets waiting to be merged.');
  lines.push('', '*Completed · most recent 6*');
  for(const t of completed) taskRow(t,false);
  if(!completed.length) lines.push('No completed tasks yet.');
  lines.push('', '*Accounts*');
  const providerCounts = new Map<string,number>();
  for(const a of state.accounts) {
    const number=(providerCounts.get(a.provider)??0)+1;providerCounts.set(a.provider,number);
    const cached=usage.get(a.id);
    const windows=cached?.windows.slice(0,4).map(w=>`${clean(w.label,20)} ${Math.round(w.percent)}%`).join(' · ');
    const percentages=cached?.windows.map(w=>w.percent).filter(Number.isFinite) ?? [];
    const peak=percentages.length ? Math.max(...percentages) : undefined;
    const limited=!!a.blockedUntil && a.blockedUntil>now;
    const blocked=limited || !!cached?.blocked || !!cached?.windows.some(w=>w.locked) || (peak!==undefined && peak>=100);
    const icon=blocked ? '🔴' : peak===undefined ? '⚪' : peak<=50 ? '🟢' : peak<90 ? '🟡' : '🟠';
    if(blocked) {
      const exhausted=cached?.windows.filter(w=>w.locked || w.percent>=100) ?? [];
      const reason=clean((limited ? a.blockedWhy : undefined) || cached?.blocked || exhausted.map(w=>`${w.label} limit reached`).join(', ') || 'Usage limit reached',160);
      const resets=[...(limited?[a.blockedUntil!]:[]),...exhausted.flatMap(w=>w.resetsAt && w.resetsAt>now ? [w.resetsAt] : [])];
      const unknownReset=exhausted.some(w=>!w.resetsAt || w.resetsAt<=now);
      const resume=resets.length && !unknownReset ? `resume after ${new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(Math.max(...resets))}` : 'resume time unavailable';
      lines.push(`${icon} ${a.provider==='claude'?'Claude':'Codex'} ${number} · blocked: ${reason} · ${resume}`);
    } else {
      const label=peak===undefined ? 'usage unavailable' : 'available';
      lines.push(`${icon} ${a.provider==='claude'?'Claude':'Codex'} ${number} · ${label}${windows?` · ${windows}`:''}${cached?` · usage ${ago(now-cached.at)} ago`:''}`);
    }
  }
  if(!state.accounts.length) lines.push('No accounts configured.');
  lines.push('', 'Open a ticket title to reply in its Slack thread. This monitor updates in place; ticket discussions stay in their own threads.', '', 'STATUS: MONITORING');
  return lines.join('\n');
}
