import { app } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IPty } from "node-pty";
import type { PtyState } from "../shared/types";

// real shells via node-pty; zsh hooks report command start/exit so the sidebar dots keep working
type Session = { id: string; scopeId: string; termId: string; pty: IPty; running: boolean; failed: boolean; buf: string };
const sessions = new Map<string, Session>();
let onData: (id: string, data: string) => void = () => {};
let onState: (s: PtyState[]) => void = () => {};
export const listen = (data: typeof onData, state: typeof onState) => { onData = data; onState = state; };
export const list = (): PtyState[] => [...sessions.values()].map(({ id, scopeId, termId, running, failed }) => ({ id, scopeId, termId, running, failed }));
const emit = () => onState(list());

const OSC = /\x1b\]7777;(start|exit;(\d+))\x07/g;

// ZDOTDIR shim: source the user's own dotfiles, then add invisible start/exit markers
function zdotdir() {
  const dir = join(app.getPath("userData"), "zsh");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".zshenv"), `[ -f "$HOME/.zshenv" ] && source "$HOME/.zshenv"\n`);
  writeFileSync(join(dir, ".zprofile"), `[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"\n`);
  writeFileSync(join(dir, ".zlogin"), `[ -f "$HOME/.zlogin" ] && source "$HOME/.zlogin"\n`);
  writeFileSync(join(dir, ".zshrc"), `export ZDOTDIR="$HOME"\n[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"\n` +
    `autoload -Uz add-zsh-hook\n_consort_pre() { printf '\\e]7777;start\\a' }\n_consort_post() { printf '\\e]7777;exit;%s\\a' $? }\n` +
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
  const s: Session = { id, scopeId, termId, pty, running: false, failed: false, buf: "" };
  sessions.set(id, s);
  pty.onData((d) => {
    // strip our markers before they reach xterm; a marker may straddle chunks, so keep a small tail
    const text = s.buf + d;
    let out = "", last = 0, changed = false;
    for (const m of text.matchAll(OSC)) {
      out += text.slice(last, m.index); last = m.index! + m[0].length;
      if (m[1] === "start") { s.running = true; changed = true; }
      else { const code = +m[2]; s.running = false; if (code > 0 && code !== 130) s.failed = true; changed = true; }
    }
    const rest = text.slice(last);
    // hold back only a partial marker ("\x1b]7777;…" without its BEL), never ordinary escape codes
    const cut = rest.lastIndexOf("\x1b]");
    const tail = cut >= 0 ? rest.slice(cut) : "";
    const partial = tail && !tail.includes("\x07") && tail.length < 40 && ("\x1b]7777;".startsWith(tail) || tail.startsWith("\x1b]7777;"));
    if (partial) { out += rest.slice(0, cut); s.buf = tail; }
    else if (rest.endsWith("\x1b")) { out += rest.slice(0, -1); s.buf = "\x1b"; }
    else { out += rest; s.buf = ""; }
    if (out) onData(id, out);
    if (changed) emit();
  });
  pty.onExit(() => { sessions.delete(id); emit(); onData(id, "\r\n[shell exited]\r\n"); });
  emit();
  return id;
}
export const write = (id: string, data: string) => sessions.get(id)?.pty.write(data);
export const resize = (id: string, cols: number, rows: number) => { try { sessions.get(id)?.pty.resize(Math.max(2, cols), Math.max(1, rows)); } catch {} };
export const kill = (id: string) => { const s = sessions.get(id); if (s) { s.pty.kill(); sessions.delete(id); emit(); } };
export const seen = (id: string) => { const s = sessions.get(id); if (s?.failed) { s.failed = false; emit(); } };
export const killAll = () => { for (const s of sessions.values()) s.pty.kill(); sessions.clear(); };
