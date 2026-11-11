/**
 * Test sessions: the owner says "I want to test it" in a task's Slack thread. The daemon stops the
 * worker's current step; the restarted worker runs one agent turn that starts the app from the
 * worktree on the task's ports and makes a local login for each role the change needs, then
 * shares the app through ngrok and posts the link and the logins. The worker waits until the
 * owner says "done", stops what the session started, puts back any file the session changed,
 * and carries on where it stopped. Nothing here is specific to one repository.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const TEST_DIR = ".consort/test-session";
export const SESSION_FILE = `${TEST_DIR}/session.json`;

export type TestLogin = { role: string; username: string; password?: string; notes?: string };
export type TestSessionFile = { port: number; path?: string; pids?: number[]; logins?: TestLogin[]; /** what to try by hand: one line per story, with the login and page it needs */ tries?: { story: string; login?: string; path?: string }[]; notes?: string[]; stop?: string };
/** what the task remembers while a session is open, so a restarted worker can clean up after the last one */
export type TestSessionState = { /** the owner pressed Resume on the board: the worker closes the session (cli/slackSocket.ts) */ endRequested?: number; requestedAt: number; requestTs: string; readyTs?: string; url?: string; pids?: number[]; tunnelPid?: number; stop?: string; dirtyBefore?: string[] };

const plain = (text: string) => text.toLowerCase().replace(/<@[A-Z0-9]+>/gi, "").replace(/:[a-z0-9_+-]+:/g, "").replace(/[’']/g, "'").replace(/[^\p{L}\p{N}'\s/]/gu, " ").replace(/\s+/g, " ").trim();

/** "I want to test it", "can you spin up a localhost so I can demo it", "give me a test link" */
export function isTestRequest(text: string): boolean {
  const t = plain(text);
  if (!t || t.length > 400) return false;
  const meTry = /\b(?:i|we) (?:want to|wanna|would like to|'d like to|need to) (?:test|try|demo|play with|click through|check out|poke at)\b|\b(?:let me|can i|could i|so i can|so we can|for me to) (?:test|try|demo|play with|click through|check out|poke at)\b/;
  const giveMe = /\b(?:spin up|start|bring up|stand up|fire up|give me|send me|share)\b.{0,40}\b(?:localhost|local server|server|test link|test url|test session|ngrok|demo|preview)\b/;
  // "why does your ngrok say…", "I didn't ask for a test session": talking about one is not asking for one
  if (/\b(?:didn'?t|did not|don'?t|do not|never|not) (?:ask|want|need)\b/.test(t)) return false;
  return meTry.test(t) || giveMe.test(t) || /\btest it myself\b|\bmanual(?:ly)? test (?:it|this)\b/.test(t);
}

/** "done", "ok done", "done testing", "continue": the owner is finished testing */
export function isTestDone(text: string): boolean {
  const t = plain(text);
  return /^(?:ok(?:ay)? |cool |great |thanks? )?(?:i'?m |i am |we'?re |we are |all )?(?:done|finished)(?: testing| with (?:it|the test(?:ing)?))?\b|^(?:ok(?:ay)? |cool )?(?:continue|carry on|go ahead|resume|proceed|keep going|you can continue)\b/.test(t)
    // "where are we at? I am "Done" with the test server btw": said anywhere in the message
    || /\b(?:done|finished) (?:with )?(?:the |your )?test(?:ing| server| session| link| app)?\b|\b(?:done|finished) testing\b|\b(?:close|end|stop|kill) (?:the |your )?test (?:server|session)\b/.test(t);
}

/** "done" with nothing else: no feedback to pass on */
export const isBareDone = (text: string) => isTestDone(text) && plain(text).split(" ").length <= 4;

export function testSessionPrompt(o: { repo: string; worktree: string; stage: string; ports?: string; prUrl?: string }): string {
  return `The owner wants to try this task's work by hand right now. Your job in this turn is to start the app from this worktree so a person can click through it in a browser, and make whatever logins they need. Do not change the feature, and do not commit.

Current stage: ${o.stage}.${o.prUrl ? ` PR: ${o.prUrl}.` : ""}
Worktree: ${o.worktree}${o.ports ? `\nThis task's ports: ${o.ports} (CONSORT_PORT_BASE and the other CONSORT_ variables are in your environment). Use them, never the repo's default ports.` : ""}

Do this:
1. Read the saved environment setup first (ENV.md and the scripts it names under .consort/), and bring up the services the app needs on this task's ports. Reuse services that are already up.
2. Start the user-facing app in the background so it keeps running after your turn ends: \`nohup <command> > ${TEST_DIR}/<name>.log 2>&1 & echo $!\`. Record every process id you start. Never stop them yourself.
3. Pick the ONE port a browser should open. Consort will share it through a public ngrok https address (a *.ngrok-free.app or *.ngrok.app host), with the Host header rewritten to localhost. Make the app work from that address: if the browser calls a separate API port, route it through the dev server's proxy or a relative path; allow ngrok hosts if the dev server checks them. Prefer environment variables and command flags. If you must edit a tracked file, say so in notes; Consort puts every file back when the session ends.
4. Decide what to seed and which logins to make from THIS task, not from habit: read the ticket (.consort/ship/TICKET.md), SPEC.md and its user stories, TEST-REPORT.md when present, the diff on this branch (git diff against the base), and the app's own roles and permissions code. List every story a person should be able to try by hand, and for each one the role it needs and the data that must exist for it to show (including the states the change cares about: empty, one, many, someone else's record, a deleted or edited one, an error case).
   Create one login per role those stories need, in the LOCAL database only, with a generated password (or the app's own local sign-in shortcut), using the app's seed scripts, CLI or API where they exist. Never touch production or any shared database. If the app has no logins, make none.
5. Seed that data the same way, enough to try every story on the list, and nothing about real people: made-up names, example.com emails, no real patient data.
6. Check it: request the port with curl until it answers, and sign in with each login if you can.
7. Write ${SESSION_FILE} as JSON:
   {"port": 5173, "path": "/the/page/to/open", "pids": [1234], "logins": [{"role": "admin", "username": "admin@test.local", "password": "…", "notes": "can edit everyone's notes"}], "try": [{"story": "an admin edits someone else's note", "login": "admin", "path": "/apc-admin/1"}], "notes": ["one short line per thing the tester should know"], "stop": "optional shell command that stops only the processes you started in step 2, run from the worktree"}
   Never put the environment's own teardown (down.sh, docker compose down) in "stop": the task keeps using those services after the session.
End with [test-ready] when the app answers on that port, or [test-failed: what stopped it, in one sentence].`;
}

export function readSessionFile(worktree: string): TestSessionFile | undefined {
  const file = join(worktree, SESSION_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    const port = Number(j?.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
    return {
      port,
      ...(typeof j.path === "string" && j.path.startsWith("/") ? { path: j.path } : {}),
      pids: Array.isArray(j.pids) ? j.pids.map(Number).filter((n: number) => Number.isInteger(n) && n > 1) : [],
      logins: Array.isArray(j.logins) ? j.logins.filter((l: Record<string, unknown>) => l && typeof l.username === "string").map((l: Record<string, unknown>) => ({ role: String(l.role ?? "user"), username: String(l.username), ...(l.password != null ? { password: String(l.password) } : {}), ...(l.notes ? { notes: String(l.notes) } : {}) })) : [],
      notes: Array.isArray(j.notes) ? j.notes.map(String).filter(Boolean) : [],
      tries: Array.isArray(j.try) ? j.try.filter((x: Record<string, unknown>) => x && typeof x.story === "string").slice(0, 10).map((x: Record<string, unknown>) => ({ story: String(x.story), ...(x.login ? { login: String(x.login) } : {}), ...(typeof x.path === "string" && x.path.startsWith("/") ? { path: x.path } : {}) })) : [],
      ...(typeof j.stop === "string" && j.stop.trim() ? { stop: j.stop.trim() } : {}),
    };
  } catch { return undefined; }
}

export const parseTestFailed = (text: string) => /\[test-failed:\s*([^\]]+)\]/i.exec(text)?.[1].trim();

/** the https address from one line of `ngrok --log stdout --log-format json` */
export function tunnelUrlFrom(line: string): string | undefined {
  try { const j = JSON.parse(line); return typeof j.url === "string" && j.url.startsWith("https://") ? j.url : undefined; } catch { return /url=(https:\/\/\S+)/.exec(line)?.[1]; }
}
/** an ngrok error worth showing the owner */
export function tunnelErrorFrom(line: string): string | undefined {
  try { const j = JSON.parse(line); return ["eror", "crit"].includes(j.lvl) ? String(j.err ?? j.msg ?? line) : undefined; } catch { return /ERROR|ERR_NGROK/.test(line) ? line.trim() : undefined; }
}

/** start ngrok on a port; resolves with its pid and public address, or an error the owner can act on */
export function startTunnel(port: number, opts: { bin?: string; timeoutMs?: number; rewriteHost?: boolean } = {}): Promise<{ pid: number; url: string } | { error: string }> {
  const args = ["http", String(port), "--log", "stdout", "--log-format", "json", ...(opts.rewriteHost === false ? [] : ["--host-header=rewrite"])];
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(opts.bin ?? "ngrok", args, { detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { resolve({ error: `ngrok did not start: ${(e as Error).message}` }); return; }
    let settled = false, buffer = "", lastError: string | undefined;
    const done = (r: { pid: number; url: string } | { error: string }) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    const onData = (chunk: Buffer) => {
      if (settled) return; // keep draining so ngrok never blocks on a full pipe
      buffer += chunk.toString();
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) {
        const url = tunnelUrlFrom(line);
        if (url) return done({ pid: child.pid!, url });
        lastError = tunnelErrorFrom(line) ?? lastError;
      }
    };
    child.stdout!.on("data", onData); child.stderr!.on("data", onData);
    child.on("error", (e) => done({ error: /ENOENT/.test(String(e)) ? "ngrok is not installed on this machine (brew install ngrok, then ngrok config add-authtoken <token>)" : `ngrok failed: ${e.message}` }));
    child.on("exit", (code) => done({ error: `ngrok exited ${code}${lastError ? `: ${lastError}` : ""}` }));
    const timer = setTimeout(() => { killTree(child.pid); done({ error: `ngrok gave no address within ${Math.round((opts.timeoutMs ?? 30_000) / 1000)}s${lastError ? `: ${lastError}` : ""}` }); }, opts.timeoutMs ?? 30_000);
  });
}

/** stop a process and everything it started */
export function killTree(pid: number | undefined): void {
  if (!pid || pid <= 1) return;
  let children: number[] = [];
  try { children = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split("\n").map(Number).filter((n) => n > 1); } catch {}
  for (const c of children) killTree(c);
  try { process.kill(pid, "SIGTERM"); } catch {}
}

/** wait until something answers on localhost:port */
export async function waitForPort(port: number, timeoutMs = 60_000, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const ok = await fetchImpl(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5_000), redirect: "manual" }).then(() => true, () => false);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

/** the Slack message with the link and the logins */
export function testReadyMessage(o: { url?: string; localUrl: string; session: TestSessionFile; tunnelError?: string }): string {
  const open = o.url ? `${o.url}${o.session.path ?? ""}` : undefined;
  const logins = (o.session.logins ?? []).map((l) => `• *${l.role}:* \`${l.username}\`${l.password ? ` / \`${l.password}\`` : ""}${l.notes ? ` · ${l.notes}` : ""}`);
  return [
    `⚠️ *Ready for you to test*${open ? `: <${open}|${open}>` : ""}`,
    ...(o.tunnelError ? [`• No public link: ${o.tunnelError}`] : []),
    `• On this machine: ${o.localUrl}${o.session.path ?? ""}`,
    ...(logins.length ? ["*Logins* (local test data only)", ...logins] : ["• No login needed"]),
    ...((o.session.tries ?? []).length ? ["*What to try*", ...o.session.tries!.map((t) => `• ${t.story}${t.login ? ` (as *${t.login}*)` : ""}${t.path && (o.url ?? o.localUrl) ? ` → <${o.url ?? o.localUrl}${t.path}|${t.path}>` : ""}`)] : []),
    ...(o.session.notes ?? []).slice(0, 6).map((n) => `• ${n}`),
    "",
    "Tell me 'done' when you are ready for me to continue.",
  ].join("\n");
}

/** tracked or new paths `git status` lists, so the session can put back only what it changed */
export const dirtyPaths = (porcelain: string) => porcelain.split("\n").filter((l) => l.trim()).map((l) => ({ path: l.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, ""), untracked: l.startsWith("??") })).filter((p) => !p.path.startsWith(".consort/"));

/** what the session changed: listed now, not before */
export const changedBySession = (before: string[], porcelainNow: string) => dirtyPaths(porcelainNow).filter((p) => !before.includes(p.path));

/** a stop command that would take down the task's services, which the worker still needs after the session */
export const tearsDownEnvironment = (cmd: string) => /\bdown\.sh\b|\bcompose\b[^;&|]*\bdown\b|\bdocker\s+(?:rm|stop|kill)\b/.test(cmd);
