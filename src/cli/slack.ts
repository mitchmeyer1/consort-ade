import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { replyAfter, slackMessage, slackStatus, STATUS_TAIL } from "../shared/headless.ts";
import type { SlackConfig } from "./state";
import { redactPii } from "../shared/redact.ts";
import type { SlackFile } from "./ownerUpdates";
import { slackGate } from "./phiGate.ts";

export type SlackThreadMessage = { ts: string; user?: string; text?: string; bot_id?: string; files?: SlackFile[] };

/**
 * The one channel to the owner: a Slack bot token posting into a DM with them (or a channel they
 * named). Every task gets one thread; progress lines go there, questions go there, and the
 * owner answers in the thread. No socket mode, no events API: the worker polls the thread for
 * a reply, which is enough for questions that wait minutes or hours.
 *
 * Scopes the bot token needs: chat:write (post), im:write (open the DM), im:history (read replies in
 * the DM; channels:history or groups:history instead when pointed at a channel), files:read (download
 * documents the owner attaches to an update), files:write (private dashboard images). No users:read or
 * incoming-webhook. The list the setup wizard shows is SLACK_SCOPES in setup.ts.
 */
const dashboardFiles = new Map<string, {id:string; key:string}[]>();
const dashboardDisabled = new Set<string>();
export class Slack {
  private cfg: SlackConfig;
  private fetchImpl: typeof fetch;
  private gate?: (text: string) => string;
  private retryDelay: (ms:number)=>Promise<unknown>;
  /** `gate` turns a message into what may be posted; by default the PHI/PII guard's, read from state (cli/phiGate.ts slackGate) */
  constructor(cfg: SlackConfig, fetchImpl: typeof fetch = (...a) => fetch(...a), gate: ((text: string) => string) | undefined = slackGate, retryDelay: (ms:number)=>Promise<unknown> = delay) { this.cfg = cfg; this.fetchImpl = fetchImpl; this.gate = gate; this.retryDelay=retryDelay; }

  private async api(method: string, body: Record<string, unknown>): Promise<any> {
    // form fields, not JSON: Slack's read methods (conversations.replies, conversations.history…) answer
    // invalid_arguments to a JSON body; every method accepts form encoding
    // no names, emails, phone numbers or addresses leave for Slack (shared/redact.ts); with the guard on, a message carrying an identifier is replaced by a notice
    if (typeof body.text === "string") body = { ...body, text: this.gate ? this.gate(body.text) : redactPii(body.text) };
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) if (v !== undefined) form.set(k, typeof v === "string" ? v : JSON.stringify(v));
    const res = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST", headers: { Authorization: `Bearer ${this.cfg.botToken}`, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      // a zero-length body makes Node's fetch hang against slack.com (auth.test has no fields), so none is sent then
      ...(form.size ? { body: form.toString() } : {}), signal: AbortSignal.timeout(20_000),
    });
    const j = await res.json();
    if (!j.ok) throw Object.assign(new Error(`Slack ${method}: ${j.error ?? res.status}`), { slackMessages: j.response_metadata?.messages ?? j.errors ?? [] });
    return j;
  }

  /** the channel to post in: the configured one, else a DM with the owner, opened once */
  async channel(): Promise<string> {
    if (this.cfg.channel) return this.cfg.channel;
    const j = await this.api("conversations.open", { users: this.cfg.userId });
    this.cfg.channel = j.channel.id;
    return this.cfg.channel!;
  }

  async test(): Promise<{ bot: string; team: string }> {
    const j = await this.api("auth.test", {});
    return { bot: j.user, team: j.team };
  }

  /** post a message; in `thread` when given. Resolves to the message ts, which is also the thread id for replies. */
  async post(text: string, thread?: string): Promise<string> {
    const j = await this.api("chat.postMessage", { channel: await this.channel(), text: slackStatus(STATUS_TAIL.test(text) ? text : slackMessage("update", text)), ...(thread ? { thread_ts: thread } : {}), unfurl_links: false });
    return j.ts as string;
  }

  /** A single monitor root, with no automatic per-ticket STATUS footer or thread reply. */
  async postMonitor(text: string): Promise<string> {
    const result=await this.sendMonitor("chat.postMessage", { channel: await this.channel(), text: text.split("\n")[0], parse: "none", unfurl_links: false, unfurl_media: false, blocks: await this.dashboardBlocks(text) }, text);
    await this.retireDashboardFiles();return result.ts;
  }

  /** Pin the existing root; a pin provides a shortcut without reposting the dashboard. */
  async pinMonitor(ts: string): Promise<void> {
    try { await this.api("pins.add", { channel: await this.channel(), timestamp: ts }); }
    catch (error) { if (!/already_pinned/.test(String(error))) throw error; }
  }

  /** Block sections keep Slack from splitting a long monitor into multiple root messages. */
  private monitorBlocks(text: string): unknown[] {
    const safe = this.gate ? this.gate(text) : redactPii(text);
    const chunks: string[] = [];
    let chunk = "";
    for (const line of safe.split("\n")) {
      if (chunk.length + line.length + 1 > 2900 && chunk) { chunks.push(chunk); chunk = ""; }
      for (let offset = 0; offset < line.length; offset += 2900) {
        const part = line.slice(offset, offset + 2900);
        if (chunk.length + part.length + 1 > 2900 && chunk) { chunks.push(chunk); chunk = ""; }
        chunk += (chunk ? "\n" : "") + part;
      }
    }
    if (chunk) chunks.push(chunk);
    return chunks.map(text => ({ type: "section", text: { type: "mrkdwn", text } }));
  }

  async updateMonitor(ts: string, text: string): Promise<void> {
    await this.sendMonitor("chat.update", { channel: await this.channel(), ts, text: text.split("\n")[0], blocks: await this.dashboardBlocks(text), unfurl_links: false }, text);
    await this.retireDashboardFiles();
  }

  private async sendMonitor(method:string,body:Record<string,unknown>,text:string):Promise<any>{
    for(let attempt=0;;attempt++){
      try{return await this.api(method,body);}
      catch(error){
        const messages=(error as Error & {slackMessages?:string[]}).slackMessages??[];
        // A rejected block created no message. Slack can acknowledge an upload before its image is ready.
        if(messages.some(m=>m.includes('invalid slack file')) && attempt<4){
          await this.retryDelay([250,750,1500,3000][attempt]);continue;
        }
        // Never retry an ambiguous network failure: the original root may already exist.
        if(!/Slack chat\.(?:postMessage|update): (?:invalid_blocks|invalid_arguments|file_not_found)/.test(String(error)))throw error;
        console.error(`Slack dashboard blocks rejected: ${String(error)}; using text monitor.`);
        this.dashboardCurrent=undefined;
        return this.api(method,{...body,blocks:this.monitorBlocks(text)});
      }
    }
  }

  setDashboardFiles(files:{id:string;key:string}[]):void{this.savedDashboardFiles=files;}
  getDashboardFiles():{id:string;key:string}[]{return this.dashboardCurrent ? dashboardFiles.get(this.dashboardCurrent.identity)??[] : this.savedDashboardFiles;}
  private savedDashboardFiles:{id:string;key:string}[]=[];
  /** Upload privately, then reference the image in the existing root; no file-share posts. */
  private async dashboardBlocks(text: string): Promise<unknown[]> {
    const identity=createHash('sha256').update(this.cfg.botToken+':'+await this.channel()).digest('hex');
    if(dashboardDisabled.has(identity)) return this.monitorBlocks(text);
    const safe=this.gate ? this.gate(text) : redactPii(text);
    // Ordinary guard notices and legacy/test messages keep their native text representation.
    if(!safe.startsWith('*📊 Consort master monitor*') || !safe.includes('*Working*')) return this.monitorBlocks(safe);
    try {
      const {dashboardPanels,dashboardGraphic,dashboardPng}=await import('./slackDashboard.ts');
      const panels=dashboardPanels(safe), previous=dashboardFiles.get(identity)??this.savedDashboardFiles, used:{id:string;key:string}[]=[], blocks:unknown[]=[];
      // One image precedes at most 38 native task-link rows and the update timestamp.
      const visible=[dashboardGraphic(panels)];
      for(const panel of visible){
        const key=createHash('sha256').update(panel.svg).digest('hex');
        let file=previous.find(f=>f.key===key);
        if(!file){
          const png=dashboardPng(panel.svg);
          const upload=await this.api('files.getUploadURLExternal',{filename:'consort-dashboard.png',length:png.length});
          if(!upload.file_id || !upload.upload_url) throw new Error('Slack image upload URL unavailable');
          const response=await this.fetchImpl(upload.upload_url,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:new Uint8Array(png),signal:AbortSignal.timeout(20_000)});
          if(!response.ok) throw new Error(`Slack image transfer: HTTP ${response.status}`);
          await this.api('files.completeUploadExternal',{files:[{id:upload.file_id,title:'Consort dashboard'}]});
          file={id:upload.file_id,key};
          dashboardFiles.set(identity,[...(dashboardFiles.get(identity)??previous),file]);
        }
        used.push(file);
        blocks.push({type:'image',slack_file:{id:file.id},alt_text:panel.alt});
      }
      // The image contains every task; native rows beneath it preserve independent destinations.
      for(const panel of panels)if(panel.links){
        const title=(panel.title??'Task').replace(/[*_`~]/g,'');
        blocks.push({type:'section',text:{type:'mrkdwn',text:[`*${title}*`,panel.metadata,[panel.age,panel.cost].filter(Boolean).join(' · '),panel.action,panel.links].filter(Boolean).join('\n').slice(0,2900)}});
      }
      for(const account of panels.flatMap(p=>p.accounts??[]))if(account.blocked)blocks.push({type:'section',text:{type:'mrkdwn',text:`*${account.name} · blocked*\n${account.detail}`.slice(0,2900)}});
      blocks.push({type:'context',elements:[{type:'plain_text',text:safe.split('\n')[1]??'Consort monitor'}]});
      // Keep uploaded IDs until chat.update succeeds; abandoned files can be reused on retry.
      dashboardFiles.set(identity,[...used,...(dashboardFiles.get(identity)??previous).filter(f=>!used.some(u=>u.id===f.id))]);
      this.dashboardCurrent={identity,used};
      return blocks;
    } catch(error){
      if(/missing_scope/.test(String(error))) dashboardDisabled.add(identity);
      console.error(`Slack dashboard images: ${String(error)}; using text monitor.`);
      this.dashboardCurrent=undefined;
      return this.monitorBlocks(safe);
    }
  }
  private dashboardCurrent?: {identity:string;used:{id:string;key:string}[]};
  private async retireDashboardFiles():Promise<void>{
    const current=this.dashboardCurrent;if(!current)return;
    for(const file of dashboardFiles.get(current.identity)??[])if(!current.used.some(f=>f.id===file.id)){
      try{await this.api('files.delete',{file:file.id});}catch{/* Retry retirement on the next successful update. */continue;}
      dashboardFiles.set(current.identity,(dashboardFiles.get(current.identity)??[]).filter(f=>f.id!==file.id));
    }
  }

  async permalink(ts: string): Promise<string> {
    const result = await this.api("chat.getPermalink", { channel: await this.channel(), message_ts: ts });
    if (typeof result.permalink !== "string" || !/^https:\/\//.test(result.permalink)) throw new Error("Slack returned no thread permalink");
    return result.permalink;
  }

  /** Discover only this bot's monitor roots, including legacy split posts. */
  async monitorPosts(heading: string): Promise<{ ts: string; replies: number }[]> {
    const me = await this.api("auth.test", {});
    const found: { ts: string; replies: number }[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.api("conversations.history", { channel: await this.channel(), limit: 100, ...(cursor ? { cursor } : {}) });
      for (const m of page.messages ?? []) {
        if (m.user === me.user_id && (typeof m.text === "string" && m.text.split("\n")[0].replaceAll(":bar_chart:", "📊") === heading.replaceAll(":bar_chart:", "📊")) && (!m.thread_ts || m.thread_ts === m.ts)) found.push({ ts: m.ts, replies: m.reply_count ?? 0 });
      }
      if (!page.has_more) return found;
      const next = page.response_metadata?.next_cursor;
      if (!next || seen.has(next)) throw new Error("Slack monitor history pagination did not advance");
      seen.add(next); cursor = next;
    } while (cursor);
    return found;
  }

  async findMonitor(heading: string): Promise<string | undefined> {
    return (await this.monitorPosts(heading))[0]?.ts;
  }

  /** Remove obsolete bot monitor roots only; preserve ticket threads and any replies. */
  async removeDuplicateMonitors(keep: string, heading: string): Promise<void> {
    const posts = await this.monitorPosts(heading);
    if (!posts.some(p => p.ts === keep)) throw new Error("Cannot clean monitors before confirming the current master post");
    for (const post of posts) if (post.ts !== keep && post.replies === 0) {
      try { await this.api("chat.delete", { channel: await this.channel(), ts: post.ts }); }
      catch (error) { if (!/message_not_found/.test(String(error))) throw error; }
    }
  }

  /** replace a posted message's text, e.g. the thread's first post (cli/slackCard.ts) */
  async update(ts: string, text: string): Promise<void> {
    await this.api("chat.update", { channel: await this.channel(), ts, text, unfurl_links: false });
  }

  /** Read all newer replies, including long-running ticket threads with multiple pages. */
  async threadMessages(thread: string, afterTs: string): Promise<SlackThreadMessage[]> {
    const messages: SlackThreadMessage[] = [];
    let cursor: string | undefined;
    do {
      const j = await this.api("conversations.replies", { channel: await this.channel(), ts: thread, oldest: afterTs, limit: 100, ...(cursor ? { cursor } : {}) });
      messages.push(...(j.messages ?? []));
      const next = j.response_metadata?.next_cursor;
      if (j.has_more && (!next || next === cursor)) throw new Error("Slack thread pagination did not advance.");
      cursor = next || undefined;
    } while (cursor);
    return messages;
  }

  /** wait for the owner's reply in the thread after `afterTs`; polls, and gives up after `timeoutMs` when set */
  async waitForReply(thread: string, afterTs: string, opts: { pollMs?: number; timeoutMs?: number; accept?: (text: string) => boolean; onTick?: () => void; onCheck?: (result: "answer" | "empty" | "error") => void } = {}): Promise<string | undefined> {
    const poll = opts.pollMs ?? 10_000;
    const started = Date.now();
    for (;;) {
      const j = await this.api("conversations.replies", { channel: await this.channel(), ts: thread, limit: 200 }).catch(() => undefined);
      const text = j ? replyAfter(j.messages ?? [], afterTs, this.cfg.userId, opts.accept) : undefined;
      opts.onCheck?.(text ? "answer" : j ? "empty" : "error");
      if (text) return text;
      opts.onTick?.();
      if (opts.timeoutMs && Date.now() - started > opts.timeoutMs) return undefined;
      await new Promise((r) => setTimeout(r, poll));
    }
  }
}
