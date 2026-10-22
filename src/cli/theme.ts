/**
 * The terminal look: the three muses in half-block art, cream headings, a mint accent for the
 * things that matter (what is live, what passed, what you type), and dim for the rest. Colour
 * is off when NO_COLOR is set or stdout is not a terminal, so logs and pipes stay plain.
 */

export const MARK: string[] = [
  "                ▄███▄▄",
  "        ▄██▄     ██ ▀█    ▄▄▄▄",
  "       ███▀█▄    ▀██▄▀   ▄█▀██",
  "     ███▀▄█▀  ▄████████▄ ▀▀█▄▀█▄",
  "   ▄▀█▀ ███▄ ██▀▀██████▀█▄▄██▄▀▀█",
  "   ▄▄▀▀█▀████▄     ▄▄▀  ▀█████ █▄",
  "  ██   ▀█▄▀▀▀▀█▄▄▀▀▀  ▄▄█▀▀█▀▄█ ██▄",
  "▄█▀ █    ▀▀██▄▄████▀▀▀▀▀  ▄▄██  ███▄",
  "██ ██   ███▄     ▄ ▄▄   ▀██▀ ▄  ████",
  "██ ██  ▄██████  ▀ ██    ▀▄▄███  ▀███",
  "▀██ ██ ▀████▀██▄ ▄▀ █ ▄█████ █   █▀▀",
  "  ▀█ ██ █▀███▄▀█▄▄ ▀ ▄██▀▄█ ██ ▄ █",
  "   ▄█ ▀ ▀█▀████▄▄▀  █▀▀▄█▀ ██ ▄██▀",
  "    ███▄ ▀▄▀█▄ ▀██▄▄▄▄█▀▀▄█▀ ▄▀▀",
  "      ▀▀█▄▀█▄███▄▄ ▀▀▀ ▄█▀▀▄▄▀",
  "         ▀▀ ▀▀▀██▀▀▀▄█▀▀"
];
export const MARK_WIDTH = 36;

const enabled = () => !process.env.NO_COLOR && !!process.stdout.isTTY;
const wrap = (open: string) => (s: string) => (enabled() ? `${open}${s}\x1b[0m` : s);

/** the light green-blue: rgb(159, 232, 216) */
export const mint = wrap("\x1b[38;2;159;232;216m");
export const cream = wrap("\x1b[38;2;243;234;214m");
export const dim = wrap("\x1b[2m");
export const bold = wrap("\x1b[1m");
export const green = wrap("\x1b[38;2;109;204;133m");
export const amber = wrap("\x1b[38;2;245;160;68m");
export const red = wrap("\x1b[38;2;224;122;106m");
export const blue = wrap("\x1b[38;2;100;173;255m");
/** a pale steel green for finished work: there, but quiet */
export const steel = wrap("\x1b[38;2;120;150;138m");
export const ok = (s: string) => `${green("✓")} ${s}`;
export const bad = (s: string) => `${red("✗")} ${s}`;
export const head = (s: string) => `\n${cream(bold(s))}`;
export const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** the mark in cream with the wordmark beside it; `tagline` goes under the word */
export function banner(tagline: string, right: string[] = []): string {
  const word = [bold(cream("Consort")), mint("consort-cli"), dim(tagline), "", ...right];
  const top = Math.max(0, Math.floor((MARK.length - word.length) / 2));
  return MARK.map((row, i) => `${cream(row.padEnd(MARK_WIDTH))}   ${word[i - top] ?? ""}`).join("\n");
}

/** a small inline mark for one-line headers: the middle muse only */
export const glyph = () => cream("☙");
