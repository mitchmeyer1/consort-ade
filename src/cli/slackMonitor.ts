/** Update one shared monitor root. Per-ticket listeners never use this timestamp. */
import { createHash, randomUUID } from 'node:crypto';
import { MASTER_MONITOR_HEADING, slackMasterMonitor } from '../shared/slackMonitor.ts';
import { FINISHED, recentCompleted, visibleTasks } from '../shared/headless.ts';
import { loadState, mutateState, type SlackConfig } from './state';
import { Slack } from './slack';
import { alive } from './daemonctl';
import { cachedUsage } from './usage';
const links = new Map<string,string>();
const reconciled = new Set<string>();
let active: Promise<void> | undefined;
export function refreshSlackMonitor(now=Date.now(), slackFor=(cfg:SlackConfig)=>new Slack(cfg)): Promise<void> {
  if(active) return active;
  active=refresh(now,slackFor).finally(()=>{active=undefined;});
  return active;
}
async function refresh(now:number, slackFor:(cfg:SlackConfig)=>Slack):Promise<void> {
  const snapshot=loadState();
  if(!snapshot.slack) return;
  const slack=slackFor(snapshot.slack), channel=await slack.channel(), lease=randomUUID();
  const acquired=mutateState(state=>{
    if(state.slackMonitor?.channel!==channel) state.slackMonitor={channel};
    if(state.slackMonitor.lease && state.slackMonitor.lease.until>now) return false;
    state.slackMonitor.lease={id:lease,until:now+5*60_000}; return true;
  });
  if(!acquired) return;
  try {
    let monitor=loadState().slackMonitor!;
    if(!monitor.ts) {
      const existing=await slack.findMonitor(MASTER_MONITOR_HEADING);
      if(existing) mutateState(s=>{if(s.slackMonitor?.lease?.id===lease) Object.assign(s.slackMonitor,{ts:existing,creating:undefined});});
      else if(monitor.creating) throw new Error('Slack monitor creation was interrupted; waiting to find the original post before creating another.');
    }
    const state=loadState(), tasks=visibleTasks(state.tasks,now).sort((a,b)=>b.updatedAt-a.updatedAt);
    const shown=[...tasks.filter(t=>!FINISHED.includes(t.status)||t.status==='failed').slice(0,16),...recentCompleted(tasks)];
    const threads=new Map<string,string>();
    for(const task of shown) if(task.slackThread) {
      const key=`${channel}:${task.slackThread}`;
      try {
        const url=links.get(key)??await slack.permalink(task.slackThread);
        links.set(key,url);threads.set(task.id,url);
      } catch(error) {
        // One unavailable ticket thread must not hide the entire monitor.
        console.error(`Slack master monitor ticket link ${task.ticket.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const text=slackMasterMonitor(state,threads,now,alive,cachedUsage());
    if(text.length>35000) throw new Error('Slack master monitor exceeds the single-post text limit.');
    const key=createHash('sha256').update(text).digest('hex');
    monitor=loadState().slackMonitor!;
    if(monitor.key===key && monitor.ts) {
      const identity=`${channel}:${monitor.ts}`;
      if(!reconciled.has(identity)) { await slack.removeDuplicateMonitors(monitor.ts,MASTER_MONITOR_HEADING); reconciled.add(identity); }
      return;
    }
    let ts=monitor.ts;
    if(ts) {
      try { await slack.updateMonitor(ts,text); }
      catch(error) {
        if(/message_not_found/.test(String(error))) mutateState(s=>{if(s.slackMonitor?.lease?.id===lease) Object.assign(s.slackMonitor,{ts:undefined,key:undefined,creating:undefined});});
        throw error;
      }
    } else {
      mutateState(s=>{if(s.slackMonitor?.lease?.id===lease) s.slackMonitor.creating=true;});
      try { ts=await slack.postMonitor(text); }
      catch(error) {
        // An explicit Slack rejection created nothing; a transport timeout may have created the post.
        if(/^Error: Slack chat.postMessage:/.test(String(error))) mutateState(s=>{if(s.slackMonitor?.lease?.id===lease) s.slackMonitor.creating=undefined;});
        throw error;
      }
    }
    mutateState(s=>{if(s.slackMonitor?.lease?.id===lease) Object.assign(s.slackMonitor,{ts,key,creating:undefined});});
    const identity=`${channel}:${ts}`;
    if(!reconciled.has(identity)) { await slack.removeDuplicateMonitors(ts!,MASTER_MONITOR_HEADING); reconciled.add(identity); }
  } finally {
    mutateState(s=>{if(s.slackMonitor?.lease?.id===lease) s.slackMonitor.lease=undefined;});
  }
}
