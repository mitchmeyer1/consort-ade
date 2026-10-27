/**
 * The AI usage panel as a picture, in the style of `consort-cli view`: one row per account, a thin bar per
 * limit window (5h, wk, a model's weekly) coloured by how full it is, and a blocked account's resume time. Slack's own chart
 * draws upright bars only and cannot be styled, so the monitor uploads this rendering (cli/slack.ts) and shows
 * it full width; the chart stays as the fallback when the upload is not possible.
 */
import { monitorAccounts, monitorSystem, type AccountUsage } from './slackMonitorBlocks.ts';

// Slack shows every image block at the same width (about 480px) however wide it is drawn: a 1360px drawing showed
// its type at a third of the size. So the panel is drawn narrow, 640px, and its type shows 25% larger than at 800px.
const W = 640, PAD = 24, NAME_W = 150, ROW_H = 56, HEAD_H = 30, GROUP_GAP = 22, RESUME_W = 110;
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
 * With a System section, the usage rows take the left of the picture and the System box the right: Slack never
 * draws two image blocks side by side, so this is the only way to put them next to each other.
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
  if (narrow) return stackedUsage(accounts, width);
  const columns = Math.min(4, Math.max(1, ...accounts.map((a) => a.windows.length)));
  const resumeW = accounts.some((a) => a.blocked || a.resets) ? RESUME_W : 0, right = width - PAD;
  const barsX = PAD + NAME_W, barsW = right - barsX - resumeW, groupW = (barsW - (columns - 1) * GROUP_GAP) / columns;
  let y = PAD;
  // No clock in the picture: the footer line carries the update time, and a picture that only changes with the numbers is uploaded far less often.
  let body = text('USAGE', PAD, y + 18, 17, MUTED, ' letter-spacing="4"');
  if (resumeW) body += text('RESETS', right, y + 18, 14, MUTED, ' letter-spacing="2" text-anchor="end"');
  y += HEAD_H;
  for (const a of accounts) {
    body += text(clip(a.name, 12), PAD, y + 36, 21, INK, ' font-weight="600"');
    // Both lines of the column in one size and weight; only the colour says blocked.
    const at = a.blocked ? resumeAt(a.detail) : a.resets ? resumeAt(a.resets) : undefined, tone = a.blocked ? usageColor(100) : MUTED;
    if (at) body += text(at.day, right, y + 26, 14, tone, ' text-anchor="end"') + text(at.time, right, y + 43, 14, tone, ' text-anchor="end"');
    else if (a.blocked) body += text('unknown', right, y + 36, 14, tone, ' text-anchor="end"');
    if (a.blocked && !a.windows.length) body += text(clip(`blocked · ${a.detail.replace(/ · resume.*$/, '')}`, 48), barsX, y + 35, 14, usageColor(100));
    else if (!a.windows.length) body += text(clip(a.detail === 'no reading yet' ? 'no reading yet' : `no reading · ${a.detail}`, 48), barsX, y + 35, 15, MUTED);
    else a.windows.slice(0, columns).forEach((w, i) => { body += bar(barsX + i * (groupW + GROUP_GAP), y, groupW, short(w.label), String(w.percent), w.percent); });
    y += ROW_H;
  }
  return { body, height: y + 4 };
}

const STACK_ROW_H = 72, STACK_GAP = 14;
/**
 * The usage rows beside the System box, where width is short: the name with its reset or resume time on one line,
 * the bars under it across the whole column.
 */
function stackedUsage(accounts: AccountUsage[], right: number): { body: string; height: number } {
  const columns = Math.min(4, Math.max(1, ...accounts.map((a) => a.windows.length)));
  const groupW = (right - PAD - (columns - 1) * STACK_GAP) / columns;
  let y = PAD, body = text('USAGE', PAD, y + 18, 17, MUTED, ' letter-spacing="4"');
  y += HEAD_H + 2;
  for (const a of accounts) {
    body += text(clip(a.name, 12), PAD, y + 22, 21, INK, ' font-weight="600"');
    // Only the colour says blocked.
    const at = a.blocked ? resumeAt(a.detail) : a.resets ? resumeAt(a.resets) : undefined, tone = a.blocked ? usageColor(100) : MUTED;
    if (at) body += text(`${at.day} ${at.time}`, right, y + 21, 14, tone, ' text-anchor="end"');
    else if (a.blocked) body += text('resume unknown', right, y + 21, 14, tone, ' text-anchor="end"');
    const words = Math.floor((right - PAD) / 8.6);
    if (a.blocked && !a.windows.length) body += text(clip(`blocked · ${a.detail.replace(/ · resume.*$/, '')}`, words), PAD, y + 48, 14, usageColor(100));
    else if (!a.windows.length) body += text(clip(a.detail === 'no reading yet' ? 'no reading yet' : `no reading · ${a.detail}`, words), PAD, y + 48, 15, MUTED);
    else a.windows.slice(0, columns).forEach((w, i) => { body += bar(PAD + i * (groupW + STACK_GAP), y + 20, groupW, short(w.label), String(w.percent), w.percent); });
    y += STACK_ROW_H;
  }
  return { body, height: y + PAD - 8 };
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
const SPLIT = 372, SYS_GAP = 24, SYS_ALONE_W = 320, COUNT_H = 38, BAR_H = 48, LINE_H = 19;
const CHART_H = 84, CHART_BARS_H = 36;
/** `10 15 - 20` from the monitor text as numbers, `-` as no reading; undefined without a series. */
const series = (s: string | undefined) => (s ? s.split(' ').map((v) => (v === '-' ? null : Number(v))) : undefined);
/** A label and the current value over a small bar chart, one bar per two minutes, oldest on the left, each coloured by how full it is. */
function chart(x: number, y: number, width: number, label: string, value: string, percent: number, values: (number | null)[]): string {
  let out = text(label, x, y + 26, 14, MUTED) + text(value, x + width, y + 26, 17, usageColor(Math.max(0, Math.min(100, percent))), ' text-anchor="end" font-weight="700"');
  const gap = 3, barW = (width - (values.length - 1) * gap) / values.length, top = y + 36, base = top + CHART_BARS_H;
  values.forEach((v, i) => {
    const bx = (x + i * (barW + gap)).toFixed(1);
    out += `<rect x="${bx}" y="${top}" width="${barW.toFixed(1)}" height="${CHART_BARS_H}" rx="2" fill="${TRACK}"/>`;
    if (v === null) return;
    const pct = Math.max(0, Math.min(100, v)), h = Math.max(3, (CHART_BARS_H * pct) / 100);
    out += `<rect x="${bx}" y="${(base - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${usageColor(pct)}"/>`;
  });
  return out;
}
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
    { label: 'DB SETS', value: num(system.Databases, /^(\d+)/)?.[0], note: system.Databases?.match(/(\d+ in use)/)?.[1] },
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
  const cpu30 = series(system.CPU30), mem30 = series(system.Memory30);
  if (cpu && cpu30) { body += chart(x0, y - 14, width, 'cpu · 30m', `${cpu[0]}%`, cpu[0]!, cpu30); y += CHART_H; }
  else if (cpu) { body += bar(x0, y - 14, width, 'cpu', `${cpu[0]}%`, cpu[0]!); y += BAR_H; }
  if (mem && mem[1] && mem30) { body += chart(x0, y - 14, width, 'memory · 30m', `${mem[0]}/${mem[1]} GB`, (100 * mem[0]!) / mem[1], mem30); y += CHART_H; }
  else if (mem && mem[1]) { body += bar(x0, y - 14, width, 'memory', `${mem[0]}/${mem[1]} GB`, (100 * mem[0]!) / mem[1]); y += BAR_H; }
  if (disk && disk[1]) { body += bar(x0, y - 14, width, 'disk', `${disk[0]} GB free`, 100 - (100 * disk[0]!) / disk[1]); y += BAR_H; }
  // The machine on up to two lines: the chip and cores, then the OS.
  const parts = (system.Machine ?? '').split(' · ').filter(Boolean), chars = Math.floor(width / 8.4);
  const lines = parts.length > 2 ? [parts.slice(0, -1).join(' · '), parts.at(-1)!] : parts.length ? [parts.join(' · ')] : [];
  for (const line of lines) { body += text(clip(line, chars), x0, y + 6, 14, MUTED); y += LINE_H; }
  return { body, height: y + PAD - 4 };
}

/** Plain words for the image's alt text. */
export function usageAlt(accounts: AccountUsage[], system: Record<string, string> = {}): string {
  const sys = Object.keys(system).length ? ` System: ${Object.entries(system).filter(([k]) => !k.endsWith('30')).map(([k, v]) => `${k} ${v}`).join('; ')}` : '';
  return (accounts.length ? 'AI usage: ' : '') + accounts.map((a) => `${a.name} ${a.blocked ? `blocked, ${a.detail}` : a.windows.length ? a.windows.map((w) => `${short(w.label)} ${w.percent}%`).join(', ') : 'no reading'}`).join('; ') + sys;
}

/**
 * The panel for a master monitor text, or undefined when it lists no accounts and no System section. `part` draws
 * the usage rows or the System box alone, each its own picture for the two cards of a Slack carousel.
 */
export function usageGraphic(safe: string, part?: 'usage' | 'system'): { svg: string; alt: string } | undefined {
  const accounts = part === 'system' ? [] : monitorAccounts(safe), system = part === 'usage' ? {} : monitorSystem(safe);
  if (!accounts.length && !Object.keys(system).length) return undefined;
  return { svg: usageSvg(accounts, system), alt: usageAlt(accounts, system) };
}

/** PNG at 2x of the SVG's size, so a retina screen shows it sharp; the native rasterizer loads only here, so the rest of the CLI never needs it. */
export async function usagePng(svg: string): Promise<Buffer> {
  const { Resvg } = await import('@resvg/resvg-js');
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 }, font: { loadSystemFonts: true, defaultFontFamily: 'Menlo' } }).render().asPng());
}
