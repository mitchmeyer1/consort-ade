import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { replyAfter, slackMessage, slackStatus, STATUS_TAIL } from "../shared/headless.ts";
import type { SlackConfig } from "./state";
import { redactPii } from "../shared/redact.ts";
import type { SlackFile } from "./ownerUpdates";
import { slackGate } from "./phiGate.ts";
import { monitorBlockKit, type UsageImage } from "./slackMonitorBlocks.ts";
/** a rendered picture's file ids and picture hash, as state saves them */
export type UsageFiles = { file?: string; key?: string; stale?: string };
/** The monitor's two uploaded pictures: the AI usage panel and the header with the group counts. */
type ImageSlot = "usage" | "head";
type ShownImage = UsageImage & { key: string; reused: boolean };

export type SlackThreadMessage = { ts: string; user?: string; text?: string; bot_id?: string; files?: SlackFile[] };

/**
 * The one channel to the owner: a Slack bot token posting into a DM with them (or a channel they
 * named). Every task gets one thread; progress lines go there, questions go there, and the
 * owner answers in the thread. No socket mode, no events API: the worker polls the thread for
 * a reply, which is enough for questions that wait minutes or hours.
 *
 * Scopes the bot token needs: chat:write (post), im:write (open the DM), im:history (read replies in
 * the DM; channels:history or groups:history instead when pointed at a channel), files:read (download
 * documents the owner attaches to an update), files:write (the PR article in a review thread, the monitor's pictures),
 * pins:write (pin the monitor). No users:read or incoming-webhook. The list the setup wizard shows is SLACK_SCOPES in
 * setup.ts; docs/slack-app-manifest.json creates an app with them and the Home tab the monitor is also published to.
 */
/** Home tab errors already logged, so a recurring one is reported once per process. */
const homeErrors = new Set<string>();
/** Bots whose token lacks files:write: picture uploads are not tried again this process. */
const usageUploadsDisabled = new Set<string>();
export class Slack {
  private cfg: SlackConfig;
  private fetchImpl: typeof fetch;
  private gate?: (text: string) => string;
  private retryDelay: (ms: number) => Promise<unknown>;
  /** `gate` turns a message into what may be posted; by default the PHI/PII guard's, read from state (cli/phiGate.ts slackGate) */
  constructor(cfg: SlackConfig, fetchImpl: typeof fetch = (...a) => fetch(...a), gate: ((text: string) => string) | undefined = slackGate, retryDelay: (ms: number) => Promise<unknown> = delay) { this.cfg = cfg; this.fetchImpl = fetchImpl; this.gate = gate; this.retryDelay = retryDelay; }

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

  /** Plain sections for anything that is not the master monitor; they keep Slack from splitting a long post. */
  private plainBlocks(safe: string): unknown[] {
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

  /**
   * The usage panel's files: `file` is shown now and `key` hashes its picture, so an unchanged panel is not uploaded
   * again; `stale` was shown before and is deleted on the next change, one generation late, so a client still
   * showing the older message never loses its image. State keeps the triple across restarts (cli/slackMonitor.ts).
   */
  private files: Record<ImageSlot, UsageFiles> = { usage: {}, head: {} };
  setUsageFile(saved: UsageFiles | undefined): void { this.files.usage = { ...(saved ?? {}) }; }
  getUsageFile(): UsageFiles { return { ...this.files.usage }; }
  /** The header picture's files, kept the same way as the usage panel's. */
  setHeadFile(saved: UsageFiles | undefined): void { this.files.head = { ...(saved ?? {}) }; }
  getHeadFile(): UsageFiles { return { ...this.files.head }; }

  /** Delete files this bot uploaded and no longer shows; a failure is left for next time. */
  async retireFiles(ids: string[]): Promise<void> {
    for (const id of ids) await this.api("files.delete", { file: id }).catch(() => undefined);
  }

  /** Upload privately (files:write); the id goes into an image block as slack_file. */
  private async uploadImage(png: Buffer, filename: string, title: string): Promise<string> {
    const upload = await this.api("files.getUploadURLExternal", { filename, length: png.length });
    if (!upload.file_id || !upload.upload_url) throw new Error("Slack image upload URL unavailable");
    const sent = await this.fetchImpl(upload.upload_url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(png), signal: AbortSignal.timeout(30_000) });
    if (!sent.ok) throw new Error(`Slack image transfer: HTTP ${sent.status}`);
    await this.api("files.completeUploadExternal", { files: [{ id: upload.file_id, title }] });
    return upload.file_id as string;
  }

  /**
   * A rendered picture, the usage panel (cli/slackUsageGraphic.ts) or the header (cli/slackHeadGraphic.ts): the file
   * already shown when the picture is unchanged, else rendered, uploaded and given a moment to settle, as Slack
   * rejects an edit that shows a file it is still processing. Undefined when there is none or it cannot be uploaded.
   */
  private async renderedImage(slot: ImageSlot, safe: string): Promise<ShownImage | undefined> {
    const token = createHash("sha256").update(this.cfg.botToken).digest("hex");
    if (usageUploadsDisabled.has(token)) return undefined;
    try {
      const { usageGraphic, usagePng } = await import("./slackUsageGraphic.ts");
      const graphic = slot === "usage" ? usageGraphic(safe) : (await import("./slackHeadGraphic.ts")).headGraphic(safe);
      if (!graphic) return undefined;
      const key = createHash("sha256").update(graphic.svg).digest("hex"), files = this.files[slot];
      if (files.file && files.key === key) return { fileId: files.file, alt: graphic.alt, key, reused: true };
      const fileId = await this.uploadImage(await usagePng(graphic.svg), `consort-${slot}.png`, slot === "usage" ? "AI usage" : "Consort");
      await this.retryDelay(1500);
      return { fileId, alt: graphic.alt, key, reused: false };
    } catch (error) {
      if (/missing_scope/.test(String(error))) usageUploadsDisabled.add(token);
      console.error(`Slack ${slot === "usage" ? "usage panel" : "header"}: ${String(error)}; showing the ${slot === "usage" ? "chart" : "banner"} instead.`);
      return undefined;
    }
  }

  /**
   * The monitor as Block Kit with the uploaded usage panel, else with Slack's chart, else as plain sections:
   * the first layout Slack accepts wins. A just-uploaded image Slack has not finished processing is retried
   * on the same layout. Nothing else is retried, as a timed-out post may already exist. After a success the
   * previous panel's file is deleted, and an uploaded panel that did not get shown is deleted too.
   */
  private async sendMonitor(method: string, body: Record<string, unknown>, text: string): Promise<any> {
    const safe = this.gate ? this.gate(text) : redactPii(text);
    const kit = monitorBlockKit(safe);
    const usage = kit ? await this.renderedImage("usage", safe) : undefined;
    const head = kit ? await this.renderedImage("head", safe) : undefined;
    const layouts: { blocks: unknown[]; withImage: boolean }[] = [];
    if (kit && (usage || head)) layouts.push({ blocks: monitorBlockKit(safe, Date.now(), usage, head)!, withImage: true });
    if (kit) layouts.push({ blocks: kit, withImage: false });
    layouts.push({ blocks: this.plainBlocks(safe), withImage: false });
    for (let i = 0; i < layouts.length; i++) {
      const layout = layouts[i]!;
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await this.api(method, { ...body, blocks: layout.blocks });
          await this.settleFile("usage", layout.withImage ? usage : undefined, usage);
          await this.settleFile("head", layout.withImage ? head : undefined, head);
          await this.publishHome(layouts.slice(i).map((l) => l.blocks));
          return result;
        } catch (error) {
          const messages = (error as Error & { slackMessages?: string[] }).slackMessages ?? [];
          if (layout.withImage && messages.some((m) => m.includes("invalid slack file")) && attempt < 4) { await this.retryDelay([250, 750, 1500, 3000][attempt]!); continue; }
          if (!/^Error: Slack chat\.(?:postMessage|update): invalid_blocks/.test(String(error)) || i === layouts.length - 1) throw error;
          console.error(`Slack monitor blocks rejected: ${String(error)} ${JSON.stringify(messages)}; trying the next layout.`);
          break;
        }
      }
    }
  }

  /**
   * The same dashboard on the owner's Home tab of this app, one click from Slack's sidebar: the layout the post
   * took, else the next one Slack accepts. The Home tab is extra; its failure never fails the post, and each
   * distinct error is logged once per process.
   */
  private async publishHome(layouts: unknown[][]): Promise<void> {
    if (!this.cfg.userId) return;
    for (const blocks of layouts) {
      try { await this.api("views.publish", { user_id: this.cfg.userId, view: { type: "home", blocks: blocks.slice(0, 100) } }); return; }
      catch (error) {
        const message = `${String(error)} ${JSON.stringify((error as Error & { slackMessages?: string[] }).slackMessages ?? [])}`;
        if (!homeErrors.has(message)) { homeErrors.add(message); console.error(`Slack Home tab: ${message}`); }
        if (!/invalid_blocks/.test(String(error))) return;
      }
    }
  }

  /** After a successful send: a newly shown file becomes current, the one it replaced waits a generation, the one before that is deleted; an upload that went unshown is deleted at once. */
  private async settleFile(slot: ImageSlot, shown: ShownImage | undefined, uploaded: ShownImage | undefined): Promise<void> {
    const retire = new Set<string>(), files = this.files[slot];
    if (uploaded && !uploaded.reused && uploaded.fileId !== shown?.fileId) retire.add(uploaded.fileId);
    if (shown && !shown.reused) {
      if (files.stale && files.stale !== shown.fileId && files.stale !== files.file) retire.add(files.stale);
      this.files[slot] = { file: shown.fileId, key: shown.key, stale: files.file && files.file !== shown.fileId ? files.file : undefined };
    }
    for (const id of retire) await this.api("files.delete", { file: id }).catch(() => undefined);
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
