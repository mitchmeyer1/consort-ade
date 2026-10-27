/** Update one shared monitor root. Per-ticket listeners never use this timestamp. */
import { createHash, randomUUID } from 'node:crypto';
import { MASTER_MONITOR_HEADING, slackMasterMonitor, slackMonitorGroups } from '../shared/slackMonitor.ts';
import { loadState, mutateState, type SlackConfig } from './state';
import { Slack } from './slack';
import { alive } from './daemonctl';
import { cachedUsage } from './usage';
import { monitorAuthors } from './slackMonitorAuthors';
const links = new Map<string,string>();
const reconciled = new Set<string>();
const pinAttempts = new Set<string>();
async function pinMonitor(slack: Slack, channel: string, ts: string) {
  const identity=`${channel}:${ts}`;
  if(pinAttempts.has(identity)) return;
  pinAttempts.add(identity);
  try { await slack.pinMonitor(ts); }
  catch(error) { console.error(`Slack master monitor pin: ${error instanceof Error ? error.message : String(error)}. You can pin this message manually from Slack's message menu.`); }
}
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
    // earlier layouts left their uploads in state: the dashboard images go now, the last usage panel becomes the shown file and retires a generation late
    const legacy=monitor as typeof monitor & {imageFiles?:{id:string}[];usageFile?:string};
    if(legacy.imageFiles?.length || legacy.usageFile) {
      await slack.retireFiles?.(legacy.imageFiles?.map(f=>f.id)??[]);
      const usage=monitor.usage ?? (legacy.usageFile ? {file:legacy.usageFile} : undefined);
      mutateState(s=>{ if(!s.slackMonitor) return; const l=s.slackMonitor as typeof legacy; delete l.imageFiles; delete l.usageFile; if(usage) s.slackMonitor.usage=usage; });
      monitor=loadState().slackMonitor!;
    }
    slack.setUsageFile?.(monitor.usage); slack.setHeadFile?.(monitor.head);
    if(!monitor.ts) {
      const existing=await slack.findMonitor(MASTER_MONITOR_HEADING);
      if(existing) mutateState(s=>{if(s.slackMonitor?.lease?.id===lease) Object.assign(s.slackMonitor,{ts:existing,creating:undefined});});
      else if(monitor.creating) throw new Error('Slack monitor creation was interrupted; waiting to find the original post before creating another.');
    }
    const state=loadState(), {working,ready,completed}=slackMonitorGroups(state,now);
    const shown=[...working.slice(0,16),...ready.slice(0,16),...completed];
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
    const text=slackMasterMonitor(state,threads,now,alive,cachedUsage(),await monitorAuthors(shown));
    if(text.length>35000) throw new Error('Slack master monitor exceeds the single-post text limit.');
    const key=createHash('sha256').update('blocks-v6:'+text).digest('hex');
    monitor=loadState().slackMonitor!;
    if(monitor.key===key && monitor.ts) {
      const identity=`${channel}:${monitor.ts}`;
      if(!reconciled.has(identity)) { await slack.removeDuplicateMonitors(monitor.ts,MASTER_MONITOR_HEADING); reconciled.add(identity); }
      await pinMonitor(slack,channel,monitor.ts);
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
    mutateState(s=>{if(s.slackMonitor?.lease?.id===lease) Object.assign(s.slackMonitor,{ts,key,creating:undefined,usage:slack.getUsageFile?.(),head:slack.getHeadFile?.()});});
    const identity=`${channel}:${ts}`;
    if(!reconciled.has(identity)) { await slack.removeDuplicateMonitors(ts!,MASTER_MONITOR_HEADING); reconciled.add(identity); }
    await pinMonitor(slack,channel,ts!);
  } finally {
    mutateState(s=>{if(s.slackMonitor?.lease?.id===lease) s.slackMonitor.lease=undefined;});
  }
}
