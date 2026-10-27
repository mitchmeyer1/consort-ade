import { replyAfter, slackMessage, slackStatus, STATUS_TAIL } from "../shared/headless.ts";
import type { SlackConfig } from "./state";
import { redactPii } from "../shared/redact.ts";
import type { SlackFile } from "./ownerUpdates";
import { slackGate } from "./phiGate.ts";
import { monitorBlockKit } from "./slackMonitorBlocks.ts";

export type SlackThreadMessage = { ts: string; user?: string; text?: string; bot_id?: string; files?: SlackFile[] };

/**
 * The one channel to the owner: a Slack bot token posting into a DM with them (or a channel they
 * named). Every task gets one thread; progress lines go there, questions go there, and the
 * owner answers in the thread. No socket mode, no events API: the worker polls the thread for
 * a reply, which is enough for questions that wait minutes or hours.
 *
 * Scopes the bot token needs: chat:write (post), im:write (open the DM), im:history (read replies in
 * the DM; channels:history or groups:history instead when pointed at a channel), files:read (download
 * documents the owner attaches to an update), files:write (the PR article in a review thread). No users:read or
 * incoming-webhook. The list the setup wizard shows is SLACK_SCOPES in setup.ts.
 */
export class Slack {
  private cfg: SlackConfig;
  private fetchImpl: typeof fetch;
  private gate?: (text: string) => string;
  /** `gate` turns a message into what may be posted; by default the PHI/PII guard's, read from state (cli/phiGate.ts slackGate) */
  constructor(cfg: SlackConfig, fetchImpl: typeof fetch = (...a) => fetch(...a), gate: ((text: string) => string) | undefined = slackGate) { this.cfg = cfg; this.fetchImpl = fetchImpl; this.gate = gate; }

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
    if (!j.ok) throw Object.assign(new Error(`Slack ${method}: ${j.error ?? res.status}`), { slackMessages: j.response_metadata?.messages ?? [] });
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
    return (await this.sendMonitor("chat.postMessage", { channel: await this.channel(), text: text.split("\n")[0], parse: "none", unfurl_links: false, unfurl_media: false }, text)).ts;
  }

  /** Pin the existing root; a pin provides a shortcut without reposting the monitor. */
  async pinMonitor(ts: string): Promise<void> {
    try { await this.api("pins.add", { channel: await this.channel(), timestamp: ts }); }
    catch (error) { if (!/already_pinned/.test(String(error))) throw error; }
  }

  /** The monitor as Block Kit (cli/slackMonitorBlocks.ts); any other text as plain sections, which keep Slack from splitting a long post. */
  private monitorBlocks(text: string, plain = false): unknown[] {
    const safe = this.gate ? this.gate(text) : redactPii(text);
    if (!plain) { const blocks = monitorBlockKit(safe); if (blocks) return blocks; }
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
    await this.sendMonitor("chat.update", { channel: await this.channel(), ts, text: text.split("\n")[0], unfurl_links: false }, text);
  }

  /** Should Slack reject the Block Kit layout, the same root gets the plain-section monitor; nothing else is retried, as a timed-out post may already exist. */
  private async sendMonitor(method: string, body: Record<string, unknown>, text: string): Promise<any> {
    try { return await this.api(method, { ...body, blocks: this.monitorBlocks(text) }); }
    catch (error) {
      if (!/^Error: Slack chat\.(?:postMessage|update): invalid_blocks/.test(String(error))) throw error;
      console.error(`Slack monitor blocks rejected: ${String(error)} ${JSON.stringify((error as { slackMessages?: unknown }).slackMessages ?? [])}; using the text monitor.`);
      return this.api(method, { ...body, blocks: this.monitorBlocks(text, true) });
    }
  }

  /**
   * A file into the thread (or the channel): uploaded privately, then shared with its comment. Needs
   * files:write. The comment passes the same gate as a message; the content is the caller's to gate.
   */
  async uploadFile(file: { filename: string; title: string; content: Buffer | string; thread?: string; comment?: string }): Promise<string> {
    const bytes = typeof file.content === "string" ? Buffer.from(file.content, "utf8") : file.content;
    const upload = await this.api("files.getUploadURLExternal", { filename: file.filename, length: bytes.length });
    if (!upload.file_id || !upload.upload_url) throw new Error("Slack file upload URL unavailable");
    const sent = await this.fetchImpl(upload.upload_url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(30_000) });
    if (!sent.ok) throw new Error(`Slack file transfer: HTTP ${sent.status}`);
    const comment = file.comment ? (this.gate ? this.gate(file.comment) : redactPii(file.comment)) : undefined;
    await this.api("files.completeUploadExternal", { files: [{ id: upload.file_id, title: file.title }], channel_id: await this.channel(), ...(file.thread ? { thread_ts: file.thread } : {}), ...(comment ? { initial_comment: comment } : {}) });
    return upload.file_id as string;
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
