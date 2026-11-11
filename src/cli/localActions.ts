/**
 * The board's Test and Resume buttons as plain links: a small page the daemon serves on this Mac
 * (127.0.0.1 only). Slack opens a link without telling the app, so no Socket Mode or app-level token
 * is needed; the link carries a secret kept in state so nothing else on the machine can start a session.
 * Works when the owner clicks in Slack on the machine running Consort.
 */
import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { loadState, mutateState } from "./state";

export const LOCAL_ACTIONS_PORT = 47821;
export type LocalActions = { port: number; key: string };
export type LocalAction = "test" | "resume";

/** the port and secret, made once and kept in state */
export function localActions(): LocalActions {
  const saved = loadState().localActions;
  if (saved?.key) return saved;
  const made = { port: LOCAL_ACTIONS_PORT, key: randomBytes(18).toString("base64url") };
  mutateState((s) => { s.localActions ??= made; });
  return loadState().localActions ?? made;
}

/** the link a board button opens for one task thread */
export const actionLink = (o: LocalActions, action: LocalAction, thread: string) => `http://127.0.0.1:${o.port}/${action}?thread=${encodeURIComponent(thread)}&k=${encodeURIComponent(o.key)}`;

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const page = (title: string, line: string) => `<!doctype html><meta charset="utf-8"><title>Consort</title><body style="font:16px -apple-system,system-ui,sans-serif;background:#1a1d21;color:#e8e8e8;display:grid;place-items:center;height:90vh;margin:0"><div style="max-width:34rem"><h2 style="margin:0 0 .5rem">${escape(title)}</h2><p style="color:#aaa;margin:0">${escape(line)}</p></div></body>`;

/** what a click does; returns the line shown in the browser tab */
export type LocalHandlers = Record<LocalAction, (taskId: string) => Promise<string>>;

/** answer one request: check the secret, find the task by its thread, run the action */
export async function handleLocalAction(url: string, o: LocalActions, handlers: LocalHandlers): Promise<{ status: number; html: string }> {
  const u = new URL(url, "http://127.0.0.1");
  const action = u.pathname.replace(/^\//, "") as LocalAction;
  if (action !== "test" && action !== "resume") return { status: 404, html: page("Not found", "This link is not one Consort made.") };
  if (!same(u.searchParams.get("k") ?? "", o.key)) return { status: 403, html: page("Link expired", "This link is from another Consort setup. Use the button on the latest board.") };
  const thread = u.searchParams.get("thread") ?? "";
  const task = loadState().tasks.find((t) => t.slackThread === thread);
  if (!task) return { status: 404, html: page("Task not found", "That task is no longer open in Consort.") };
  try { return { status: 200, html: page(task.ticket.title, `${await handlers[action](task.id)} You can close this tab.`) }; }
  catch (e) { return { status: 500, html: page("Something went wrong", (e as Error).message) }; }
}

/** listen on 127.0.0.1 while the daemon runs; a port already in use is logged, not fatal */
export function serveLocalActions(handlers: LocalHandlers, log: (line: string) => void = console.error): Server {
  const o = localActions();
  const server = createServer((req, res) => {
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    void handleLocalAction(req.url ?? "/", o, handlers).then(({ status, html }) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html); });
  });
  server.on("error", (e) => log(`Board Test/Resume links unavailable: ${(e as Error).message}`));
  server.listen(o.port, "127.0.0.1");
  return server;
}
