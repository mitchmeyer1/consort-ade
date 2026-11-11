/**
 * Board button clicks over Slack Socket Mode (docs/slack-buttons-plan.md). Every consort-cli on the
 * shared app may get any click, so a click is never acted on here: it is handed to the owner's
 * consort-cli as a thread reply carrying metadata, which that daemon reads on its usual thread poll
 * (cli/slackStatus.ts). Only runs with an app-level token (xapp-…, connections:write).
 */
import { Slack } from "./slack";
import type { SlackConfig } from "./state";
import { RESUME_ACTION, TEST_ACTION } from "./slackMonitorBlocks.ts";

/** the metadata event a Test click becomes; its payload's `user` is who clicked */
export const TEST_RELAY = "consort_test";
/** the metadata event a Resume click becomes: end the task's test session */
export const RESUME_RELAY = "consort_resume";

type Envelope = { envelope_id?: string; type?: string; payload?: { type?: string; user?: { id?: string }; actions?: { action_id?: string; value?: string }[] } };

/** the relay a block_actions payload asks for, or undefined when it is not a Test click */
export function testClick(payload: Envelope["payload"]): { channel: string; thread: string; user: string; resume: boolean } | undefined {
  if (payload?.type !== "block_actions" || !payload.user?.id) return undefined;
  const action = payload.actions?.find((a) => a.action_id?.startsWith(TEST_ACTION) || a.action_id?.startsWith(RESUME_ACTION));
  const m = action?.value?.match(/^([A-Z0-9]+):(\d+\.\d+)$/);
  return m ? { channel: m[1], thread: m[2], user: payload.user.id, resume: !!action?.action_id?.startsWith(RESUME_ACTION) } : undefined;
}

export type SocketDeps = { fetch: typeof fetch; WebSocket: typeof WebSocket; slack: (cfg: SlackConfig) => Pick<Slack, "postRelay">; log: (line: string) => void; delay: (ms: number) => Promise<unknown> };
const defaults: SocketDeps = { fetch: (...a) => fetch(...a), WebSocket: globalThis.WebSocket, slack: (cfg) => new Slack(cfg), log: (l) => console.log(`${new Date().toISOString()} ${l}`), delay: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** handle one Socket Mode frame: acknowledge it, and relay a Test click into the task's thread */
export async function handleFrame(raw: string, ack: (envelopeId: string) => void, cfg: SlackConfig, deps: Pick<SocketDeps, "slack" | "log"> = defaults): Promise<void> {
  let frame: Envelope;
  try { frame = JSON.parse(raw); } catch { return; }
  // Slack wants every envelope acknowledged within 3 seconds, whatever it is
  if (frame.envelope_id) ack(frame.envelope_id);
  if (frame.type !== "interactive") return;
  const click = testClick(frame.payload);
  if (!click) return;
  const [text, event] = click.resume ? [`▶️ <@${click.user}> pressed *Resume* on the board: closing the test session.`, RESUME_RELAY] : [`🧪 <@${click.user}> pressed *Test* on the board: starting a test session.`, TEST_RELAY];
  const name = click.resume ? "Resume" : "Test";
  await deps.slack(cfg).postRelay(click.channel, click.thread, text, event, { user: click.user })
    .then(() => deps.log(`Slack ${name} click from ${click.user} relayed to thread ${click.thread}`), (e) => deps.log(`Slack ${name} click relay failed: ${(e as Error).message}`));
}

/** keep one Socket Mode connection open while the daemon runs; reconnects when Slack asks or the socket drops */
export async function listenForClicks(cfg: SlackConfig, deps: SocketDeps = defaults, stop = { stopped: false }): Promise<void> {
  if (!cfg.appToken) return;
  let failures = 0;
  while (!stop.stopped) {
    try {
      const res = await deps.fetch("https://slack.com/api/apps.connections.open", { method: "POST", headers: { Authorization: `Bearer ${cfg.appToken}` } });
      const j = await res.json() as { ok: boolean; url?: string; error?: string };
      if (!j.ok || !j.url) throw new Error(`apps.connections.open: ${j.error ?? res.status}`);
      await new Promise<void>((resolve) => {
        const ws = new deps.WebSocket(j.url!);
        ws.onopen = () => { failures = 0; deps.log("Slack Socket Mode connected: board buttons are live"); };
        ws.onmessage = (ev) => {
          const raw = String(ev.data);
          if (/"type"\s*:\s*"disconnect"/.test(raw)) { ws.close(); return; }
          void handleFrame(raw, (id) => ws.send(JSON.stringify({ envelope_id: id })), cfg, deps);
        };
        ws.onclose = () => resolve();
        ws.onerror = () => { try { ws.close(); } catch {} resolve(); };
      });
    } catch (e) {
      failures++;
      deps.log(`Slack Socket Mode: ${(e as Error).message}; retrying`);
    }
    if (!stop.stopped) await deps.delay(Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6)));
  }
}
