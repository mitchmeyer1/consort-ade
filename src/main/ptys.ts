import { app } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IPty } from "node-pty";
import type { PtyState } from "../shared/types";
import { commandOutcome, stripMarkers } from "./ptyMarkers";

// real shells via node-pty; zsh hooks report command start/exit so the sidebar dots keep working
type Session = { id: string; scopeId: string; termId: string; pty: IPty; running: boolean; failed: boolean; done: boolean; buf: string; startedAt?: number; command?: string };
export type CommandDone = { id: string; scopeId: string; termId: string; command?: string; code: number; durationMs: number };
const sessions = new Map<string, Session>();
let onData: (id: string, data: string) => void = () => {};
let onState: (s: PtyState[]) => void = () => {};
let onDone: (d: CommandDone) => void = () => {};
export const listen = (data: typeof onData, state: typeof onState) => { onData = data; onState = state; };
/** a command that ran long enough to be worth telling the user about has finished */
export const onCommandDone = (cb: typeof onDone) => { onDone = cb; };
export const list = (): PtyState[] => [...sessions.values()].map(({ id, scopeId, termId, running, failed, done }) => ({ id, scopeId, termId, running, failed, done }));
const emit = () => onState(list());

// ZDOTDIR shim: source the user's own dotfiles, then add invisible start/exit markers
function zdotdir() {
  const dir = join(app.getPath("userData"), "zsh");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".zshenv"), `[ -f "$HOME/.zshenv" ] && source "$HOME/.zshenv"\n`);
  writeFileSync(join(dir, ".zprofile"), `[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"\n`);
  writeFileSync(join(dir, ".zlogin"), `[ -f "$HOME/.zlogin" ] && source "$HOME/.zlogin"\n`);
  writeFileSync(join(dir, ".zshrc"), `export ZDOTDIR="$HOME"\n[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"\n` +
    `autoload -Uz add-zsh-hook\n_consort_pre() { printf '\\e]7777;start;%s\\a' "\${1:0:200}" }\n_consort_post() { printf '\\e]7777;exit;%s\\a' $? }\n` +
    `add-zsh-hook preexec _consort_pre\nadd-zsh-hook precmd _consort_post\n` +
    `if [[ "$CONSORT_COMPOSER" == 1 ]]; then\n_consort_prompt() { PROMPT=$'%/\\n❯ '; RPROMPT='' }\nadd-zsh-hook precmd _consort_prompt\nfi\n`);
  return dir;
}

export async function create(scopeId: string, termId: string, cwd: string, cols: number, rows: number) {
  const { spawn } = await import("node-pty");
  const id = `${scopeId}:${termId}`;
  if (sessions.has(id)) return id;
  const composer = termId.startsWith("composer-");
  const env = { ...process.env, ZDOTDIR: zdotdir(), TERM: "xterm-256color", COLORTERM: "truecolor", LANG: process.env.LANG || "en_US.UTF-8", CONSORT: "1", CONSORT_COMPOSER: composer ? "1" : "0" } as Record<string, string>;
  const pty = spawn(composer ? "/bin/zsh" : process.env.SHELL || "/bin/zsh", ["-l"], { name: "xterm-256color", cols, rows, cwd, env });
  const s: Session = { id, scopeId, termId, pty, running: false, failed: false, done: false, buf: "" };
  sessions.set(id, s);
  pty.onData((d) => {
    // strip our markers before they reach xterm; a marker may straddle chunks, so keep a small tail
    const { out, tail, events } = stripMarkers(s.buf, d);
    s.buf = tail;
    for (const ev of events) {
      if (ev.type === "start") { s.running = true; s.done = false; s.startedAt = Date.now(); s.command = ev.command; continue; }
      const durationMs = s.startedAt === undefined ? undefined : Date.now() - s.startedAt;
      const outcome = commandOutcome(ev.code, durationMs);
      s.running = false;
      if (outcome.failed) s.failed = true;
      if (outcome.done) s.done = true;
      if (outcome.notify) onDone({ id, scopeId, termId, command: s.command, code: ev.code, durationMs: durationMs! });
      s.startedAt = undefined;
    }
    if (out) onData(id, out);
    if (events.length) emit();
  });
  pty.onExit(() => { sessions.delete(id); emit(); onData(id, "\r\n[shell exited]\r\n"); });
  emit();
  return id;
}
export const write = (id: string, data: string) => sessions.get(id)?.pty.write(data);
export const resize = (id: string, cols: number, rows: number) => { try { sessions.get(id)?.pty.resize(Math.max(2, cols), Math.max(1, rows)); } catch {} };
export const kill = (id: string) => { const s = sessions.get(id); if (s) { s.pty.kill(); sessions.delete(id); emit(); } };
export const seen = (id: string) => { const s = sessions.get(id); if (s && (s.failed || s.done)) { s.failed = false; s.done = false; emit(); } };
/** opening the worktree counts as seeing everything that finished in it */
export const seenScope = (scopeId: string) => {
  let changed = false;
  for (const s of sessions.values()) if (s.scopeId === scopeId && (s.failed || s.done)) { s.failed = false; s.done = false; changed = true; }
  if (changed) emit();
};
export const killAll = () => { for (const s of sessions.values()) s.pty.kill(); sessions.clear(); };
