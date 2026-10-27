/**
 * The AI usage panel as a picture, in the style of `consort-cli view`: one row per account, a thin bar per
 * limit window (5h, wk, a model's weekly) coloured by how full it is, and a blocked account's resume time. Slack's own chart
 * draws upright bars only and cannot be styled, so the monitor uploads this rendering (cli/slack.ts) and shows
 * it full width; the chart stays as the fallback when the upload is not possible.
 */
import { monitorAccounts, monitorSystem, type AccountUsage } from './slackMonitorBlocks.ts';

// Slack shows an image block about 500px wide whatever its size. The panel is drawn 800px wide, so it stays crisp
// on a retina screen and its type and bars show 25% larger than a 1000px drawing would.
const W = 800, PAD = 24, NAME_W = 150, ROW_H = 56, HEAD_H = 30, GROUP_GAP = 22, RESUME_W = 110;
const FONT = `Menlo, 'SF Mono', Consolas, 'DejaVu Sans Mono', monospace`;
const INK = '#ece6d8', MUTED = '#9a9c9e', TRACK = '#33363b';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** White to 50%, yellow to 90%, orange above. */
export const usageColor = (percent: number) => (percent <= 50 ? '#f3ead6' : percent <= 90 ? '#e9c46a' : '#f08a66');
const short = (label: string) => (/^5-?hour$/i.test(label) ? '5h' : /^weekly$/i.test(label) ? 'wk' : label.toLowerCase().slice(0, 8));
const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s);
const text = (s: string, x: number, y: number, size: number, color: string, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}"${extra}>${esc(s)}</text>`;

/** `Oct 27` and `3:30 PM` from `resume after Oct 27, 3:30 PM EDT` or `Oct 27, 3:30 PM EDT`; undefined when the time is unknown. */
export function resumeAt(detail: string): { day: string; time: string } | undefined {
  const m = detail.match(/(\w{3} \d{1,2}), (\d{1,2}:\d{2} [AP]M)/);
  return m ? { day: m[1]!, time: m[2]! } : undefined;
}

/**
 * The SVG, transparent, drawn for Slack's dark theme: one row per account with no provider headings, as the names say
 * the provider. A far-right column carries when the account frees up: a blocked one's resume time in orange, else its
 * last weekly window's reset (Fable for Claude, weekly for Codex) in grey. A blocked reason is in the alt text.
 * With a System section, the usage rows take the left of the picture and the System box the right: Slack draws an
 * image block at most about 480px wide and never two side by side, so this is the only way to put them next to each other.
 */
export function usageSvg(accounts: AccountUsage[], system: Record<string, string> = {}): string {
  const hasSystem = Object.keys(system).length > 0;
  const usageW = !hasSystem ? W : accounts.length ? SPLIT : 0;
  const usage = accounts.length ? usageBody(accounts, usageW, hasSystem) : { body: '', height: 0 };
  const sys = hasSystem ? systemBody(system, usageW ? usageW + SYS_GAP : 0) : { body: '', height: 0 };
  const width = usageW && hasSystem ? W : usageW || SYS_ALONE_W, height = Math.max(usage.height, sys.height);
  const rule = usageW && hasSystem ? `<line x1="${usageW + SYS_GAP / 2}" y1="${PAD}" x2="${usageW + SYS_GAP / 2}" y2="${height - PAD}" stroke="${TRACK}" stroke-width="2"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">${usage.body}${rule}${sys.body}</svg>`;
}

/** The usage rows in a column `width` wide from the left edge; narrower columns when the System box shares the picture. */
function usageBody(accounts: AccountUsage[], width: number, narrow: boolean): { body: string; height: number } {
  const nameW = narrow ? 108 : NAME_W, gap = narrow ? 14 : GROUP_GAP, right = narrow ? width : width - PAD;
  const columns = Math.min(4, Math.max(1, ...accounts.map((a) => a.windows.length)));
  const resumeW = accounts.some((a) => a.blocked || a.resets) ? (narrow ? 84 : RESUME_W) : 0;
  const barsX = PAD + nameW, barsW = right - barsX - resumeW, groupW = (barsW - (columns - 1) * gap) / columns;
  let y = PAD;
  // No clock in the picture: the footer line carries the update time, and a picture that only changes with the numbers is uploaded far less often.
  let body = text('USAGE', PAD, y + 18, 17, MUTED, ' letter-spacing="4"');
  if (resumeW) body += text('RESETS', right, y + 18, 14, MUTED, ' letter-spacing="2" text-anchor="end"');
  y += HEAD_H;
  for (const a of accounts) {
    body += text(clip(a.name, narrow ? 8 : 12), PAD, y + 36, 21, INK, ' font-weight="600"');
    // Both lines of the column in one size and weight; only the colour says blocked.
    const at = a.blocked ? resumeAt(a.detail) : a.resets ? resumeAt(a.resets) : undefined, tone = a.blocked ? usageColor(100) : MUTED;
    if (at) body += text(at.day, right, y + 26, 14, tone, ' text-anchor="end"') + text(at.time, right, y + 43, 14, tone, ' text-anchor="end"');
    else if (a.blocked) body += text('unknown', right, y + 36, 14, tone, ' text-anchor="end"');
    const words = Math.floor(barsW / 9);
    if (a.blocked && !a.windows.length) body += text(clip(`blocked · ${a.detail.replace(/ · resume.*$/, '')}`, Math.min(48, words)), barsX, y + 35, 14, usageColor(100));
    else if (!a.windows.length) body += text(clip(a.detail === 'no reading yet' ? 'no reading yet' : `no reading · ${a.detail}`, Math.min(48, words)), barsX, y + 35, 15, MUTED);
    else a.windows.slice(0, columns).forEach((w, i) => { body += bar(barsX + i * (groupW + gap), y, groupW, short(w.label), String(w.percent), w.percent); });
    y += ROW_H;
  }
  return { body, height: y + 4 + (narrow ? PAD - 4 : 0) };
}

/** A label over a thin bar, its value at the right in the bar's colour. */
function bar(x: number, y: number, width: number, label: string, value: string, percent: number): string {
  const pct = Math.max(0, Math.min(100, percent)), color = usageColor(pct);
  let out = text(label, x, y + 26, 14, MUTED) + text(value, x + width, y + 26, 17, color, ' text-anchor="end" font-weight="700"');
  out += `<rect x="${x}" y="${y + 35}" width="${width.toFixed(1)}" height="7" rx="3.5" fill="${TRACK}"/>`;
  if (pct > 0) out += `<rect x="${x}" y="${y + 35}" width="${Math.max(7, (width * pct) / 100).toFixed(1)}" height="7" rx="3.5" fill="${color}"/>`;
  return out;
}

// The usage rows end at SPLIT; the System box fills the rest, after a gap holding a thin rule.
const SPLIT = 520, SYS_GAP = 28, SYS_ALONE_W = 320, COUNT_H = 38, BAR_H = 48, LINE_H = 19;
const num = (s: string | undefined, re: RegExp) => { const m = s?.match(re); return m ? m.slice(1).map(Number) : undefined; };
/**
 * The System box as a column starting at `left`: counts of Consort's database sets, worktrees and running containers as
 * large numbers, then CPU, memory and disk as bars, then the machine. Drawn the way the usage rows are.
 */
function systemBody(system: Record<string, string>, left: number): { body: string; height: number } {
  const x0 = left || PAD, right = (left ? W : SYS_ALONE_W) - PAD, width = right - x0;
  let y = PAD, body = text('SYSTEM', x0, y + 18, 17, MUTED, ' letter-spacing="4"');
  y += HEAD_H + 4;
  const counts = [
    { label: 'DATABASES', value: num(system.Databases, /^(\d+)/)?.[0], note: system.Databases?.match(/(\d+ in use)/)?.[1] },
    { label: 'WORKTREES', value: num(system.Worktrees, /^(\d+)/)?.[0] },
    { label: 'CONTAINERS', value: num(system.Containers, /^(\d+)/)?.[0] },
  ];
  for (const c of counts) {
    if (c.value === undefined) continue;
    body += text(String(c.value), x0, y + 26, 26, c.value ? INK : MUTED, ' font-weight="700"');
    body += text(c.label, x0 + 56, y + 24, 13, MUTED, ' letter-spacing="2"');
    if (c.note) body += text(c.note, right, y + 24, 14, MUTED, ' text-anchor="end"');
    y += COUNT_H;
  }
  y += 2;
  const cpu = num(system.CPU, /^(\d+)%/), mem = num(system.Memory, /^(\d+) of (\d+) GB/), disk = num(system.Disk, /^(\d+) GB free of (\d+) GB/);
  if (cpu) { body += bar(x0, y - 14, width, 'cpu', `${cpu[0]}%`, cpu[0]!); y += BAR_H; }
  if (mem && mem[1]) { body += bar(x0, y - 14, width, 'memory', `${mem[0]}/${mem[1]} GB`, (100 * mem[0]!) / mem[1]); y += BAR_H; }
  if (disk && disk[1]) { body += bar(x0, y - 14, width, 'disk', `${disk[0]} GB free`, 100 - (100 * disk[0]!) / disk[1]); y += BAR_H; }
  // The machine on up to two lines: the chip and cores, then the OS.
  const parts = (system.Machine ?? '').split(' · ').filter(Boolean), chars = Math.floor(width / 8.4);
  const lines = parts.length > 2 ? [parts.slice(0, -1).join(' · '), parts.at(-1)!] : parts.length ? [parts.join(' · ')] : [];
  for (const line of lines) { body += text(clip(line, chars), x0, y + 6, 14, MUTED); y += LINE_H; }
  return { body, height: y + PAD - 4 };
}

/** Plain words for the image's alt text. */
export function usageAlt(accounts: AccountUsage[], system: Record<string, string> = {}): string {
  const sys = Object.keys(system).length ? ` System: ${Object.entries(system).map(([k, v]) => `${k} ${v}`).join('; ')}` : '';
  return (accounts.length ? 'AI usage: ' : '') + accounts.map((a) => `${a.name} ${a.blocked ? `blocked, ${a.detail}` : a.windows.length ? a.windows.map((w) => `${short(w.label)} ${w.percent}%`).join(', ') : 'no reading'}`).join('; ') + sys;
}

/** The panel for a master monitor text, or undefined when it lists no accounts and no System section. */
export function usageGraphic(safe: string): { svg: string; alt: string } | undefined {
  const accounts = monitorAccounts(safe), system = monitorSystem(safe);
  if (!accounts.length && !Object.keys(system).length) return undefined;
  return { svg: usageSvg(accounts, system), alt: usageAlt(accounts, system) };
}

/** PNG at 1x of the SVG's size; the native rasterizer loads only here, so the rest of the CLI never needs it. */
export async function usagePng(svg: string): Promise<Buffer> {
  const { Resvg } = await import('@resvg/resvg-js');
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Menlo' } }).render().asPng());
}
