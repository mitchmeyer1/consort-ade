import { replyAfter, slackMessage, slackStatus, STATUS_TAIL } from "../shared/headless.ts";
import type { SlackConfig } from "./state";
import { redactPii } from "../shared/redact.ts";
import type { SlackFile } from "./ownerUpdates";

export type SlackThreadMessage = { ts: string; user?: string; text?: string; bot_id?: string; files?: SlackFile[] };

/**
 * The one channel to the owner: a Slack bot token posting into a DM with them (or a channel they
 * named). Every task gets one thread; progress lines go there, questions go there, and the
 * owner answers in the thread. No socket mode, no events API: the worker polls the thread for
 * a reply, which is enough for questions that wait minutes or hours.
 *
 * Scopes the bot token needs: chat:write (post), im:write (open the DM), im:history (read replies in
 * the DM; channels:history or groups:history instead when pointed at a channel), files:read (download
 * documents the owner attaches to an update). Nothing else: no users:read, files:write or
 * incoming-webhook. The list the setup wizard shows is SLACK_SCOPES in setup.ts.
 */
export class Slack {
  private cfg: SlackConfig;
  private fetchImpl: typeof fetch;
  constructor(cfg: SlackConfig, fetchImpl: typeof fetch = (...a) => fetch(...a)) { this.cfg = cfg; this.fetchImpl = fetchImpl; }

  private async api(method: string, body: Record<string, unknown>): Promise<any> {
    // form fields, not JSON: Slack's read methods (conversations.replies, conversations.history…) answer
    // invalid_arguments to a JSON body; every method accepts form encoding
    // no names, emails, phone numbers or addresses leave for Slack (shared/redact.ts)
    if (typeof body.text === "string") body = { ...body, text: redactPii(body.text) };
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) if (v !== undefined) form.set(k, typeof v === "string" ? v : JSON.stringify(v));
    const res = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST", headers: { Authorization: `Bearer ${this.cfg.botToken}`, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      // a zero-length body makes Node's fetch hang against slack.com (auth.test has no fields), so none is sent then
      ...(form.size ? { body: form.toString() } : {}), signal: AbortSignal.timeout(20_000),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(`Slack ${method}: ${j.error ?? res.status}`);
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
  async waitForReply(thread: string, afterTs: string, opts: { pollMs?: number; timeoutMs?: number; onTick?: () => void; onCheck?: (result: "answer" | "empty" | "error") => void } = {}): Promise<string | undefined> {
    const poll = opts.pollMs ?? 10_000;
    const started = Date.now();
    for (;;) {
      const j = await this.api("conversations.replies", { channel: await this.channel(), ts: thread, limit: 200 }).catch(() => undefined);
      const text = j ? replyAfter(j.messages ?? [], afterTs, this.cfg.userId) : undefined;
      opts.onCheck?.(text ? "answer" : j ? "empty" : "error");
      if (text) return text;
      opts.onTick?.();
      if (opts.timeoutMs && Date.now() - started > opts.timeoutMs) return undefined;
      await new Promise((r) => setTimeout(r, poll));
    }
  }
}
