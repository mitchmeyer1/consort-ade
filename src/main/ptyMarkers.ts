/**
 * The zsh shim prints invisible OSC 7777 markers around every command: `start;<command>` from
 * preexec and `exit;<code>` from precmd. This strips them from the byte stream before it reaches
 * xterm and reports them as events, holding back a marker that straddles two chunks.
 */
export type MarkerEvent = { type: "start"; command?: string } | { type: "exit"; code: number };

const OSC = /\x1b\]7777;(?:start(?:;([^\x07]*))?|exit;(\d+))\x07/g;
const PREFIX = "\x1b]7777;";
/** the start marker carries up to this much command text, so a partial one can be this long */
export const MAX_MARKER = 400;

export function stripMarkers(buf: string, chunk: string): { out: string; tail: string; events: MarkerEvent[] } {
  const text = buf + chunk;
  const events: MarkerEvent[] = [];
  let out = "", last = 0;
  for (const m of text.matchAll(OSC)) {
    out += text.slice(last, m.index);
    last = m.index! + m[0].length;
    if (m[2] !== undefined) events.push({ type: "exit", code: +m[2] });
    else events.push({ type: "start", ...(m[1] ? { command: cleanCommand(m[1]) } : {}) });
  }
  const rest = text.slice(last);
  // hold back only a partial marker ("\x1b]7777;…" without its BEL), never ordinary escape codes
  const cut = rest.lastIndexOf("\x1b]");
  const tail = cut >= 0 ? rest.slice(cut) : "";
  const partial = tail && !tail.includes("\x07") && tail.length < MAX_MARKER && (PREFIX.startsWith(tail) || tail.startsWith(PREFIX));
  if (partial) return { out: out + rest.slice(0, cut), tail, events };
  if (rest.endsWith("\x1b")) return { out: out + rest.slice(0, -1), tail: "\x1b", events };
  return { out: out + rest, tail: "", events };
}

/** one line, control characters dropped, short enough for a notification title */
export const cleanCommand = (raw: string, max = 120) => {
  const s = raw.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};

/** commands shorter than this are instant feedback, not something to be told about later */
export const MIN_NOTIFY_MS = 1500;

/**
 * What a finished command means for the sidebar. Ctrl-C (130) is the user's own doing, so it is
 * neither a failure nor news. Quick commands leave no trace: the user was clearly watching.
 *
 * A worktree's own setup run is the exception on both counts. Nobody was watching — we started
 * it — so it reports however quickly it finishes, matching the toast that announced it. And a
 * clean one leaves no amber "come and look" dot, because there is nothing in an install to look
 * at. A `durationMs` of undefined still means no command actually ran: the shell's first prompt
 * fires an exit marker of its own, and that is not news in either mode.
 */
export function commandOutcome(code: number, durationMs: number | undefined, setup = false): { failed: boolean; done: boolean; notify: boolean } {
  const failed = code > 0 && code !== 130;
  const ran = durationMs !== undefined;
  if (setup) return { failed, done: false, notify: ran && code !== 130 };
  const long = ran && durationMs >= MIN_NOTIFY_MS;
  return { failed, done: long && !failed && code !== 130, notify: long && code !== 130 };
}

/** "2s" / "1m 05s" / "1h 02m" for the notification body */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
