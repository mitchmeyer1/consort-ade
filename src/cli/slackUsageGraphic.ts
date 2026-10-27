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
 */
export function usageSvg(accounts: AccountUsage[], system: Record<string, string> = {}): string {
  const columns = Math.min(4, Math.max(1, ...accounts.map((a) => a.windows.length)));
  const resumeW = accounts.some((a) => a.blocked || a.resets) ? RESUME_W : 0;
  const usageH = accounts.length ? PAD + HEAD_H + accounts.length * ROW_H + 4 : 0;
  const sys = systemBody(system, usageH);
  const height = usageH + sys.height;
  const barsX = PAD + NAME_W, barsW = W - PAD - barsX - resumeW, groupW = (barsW - (columns - 1) * GROUP_GAP) / columns;
  let y = PAD;
  if (!accounts.length) return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="${FONT}">${sys.body}</svg>`;
  // No clock in the picture: the footer line carries the update time, and a picture that only changes with the numbers is uploaded far less often.
  let body = text('USAGE', PAD, y + 18, 17, MUTED, ' letter-spacing="4"');
  if (resumeW) body += text('RESETS', W - PAD, y + 18, 14, MUTED, ' letter-spacing="2" text-anchor="end"');
  y += HEAD_H;
  for (const a of accounts) {
    body += text(clip(a.name, 12), PAD, y + 36, 21, INK, ' font-weight="600"');
    // Both lines of the column in one size and weight; only the colour says blocked.
    const at = a.blocked ? resumeAt(a.detail) : a.resets ? resumeAt(a.resets) : undefined, tone = a.blocked ? usageColor(100) : MUTED;
    if (at) body += text(at.day, W - PAD, y + 26, 14, tone, ' text-anchor="end"') + text(at.time, W - PAD, y + 43, 14, tone, ' text-anchor="end"');
    else if (a.blocked) body += text('unknown', W - PAD, y + 36, 14, tone, ' text-anchor="end"');
    if (a.blocked && !a.windows.length) body += text(clip(`blocked · ${a.detail.replace(/ · resume.*$/, '')}`, 48), barsX, y + 35, 14, usageColor(100));
    else if (!a.windows.length) body += text(clip(a.detail === 'no reading yet' ? 'no reading yet' : `no reading · ${a.detail}`, 48), barsX, y + 35, 15, MUTED);
    else a.windows.slice(0, columns).forEach((w, i) => {
      const x = barsX + i * (groupW + GROUP_GAP), pct = Math.max(0, Math.min(100, w.percent)), color = usageColor(pct);
      body += text(short(w.label), x, y + 26, 14, MUTED) + text(String(w.percent), x + groupW, y + 26, 17, color, ' text-anchor="end" font-weight="700"');
      body += `<rect x="${x}" y="${y + 35}" width="${groupW.toFixed(1)}" height="7" rx="3.5" fill="${TRACK}"/>`;
      if (pct > 0) body += `<rect x="${x}" y="${y + 35}" width="${Math.max(7, (groupW * pct) / 100).toFixed(1)}" height="7" rx="3.5" fill="${color}"/>`;
    });
    y += ROW_H;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="${FONT}">${body}${sys.body}</svg>`;
}

const TILE_H = 74, MACHINE_H = 34;
const num = (s: string | undefined, re: RegExp) => { const m = s?.match(re); return m ? m.slice(1).map(Number) : undefined; };
/**
 * The System box under the usage rows, drawn the same way: counts of Consort's database sets, worktrees and running
 * containers as large numbers, then CPU, memory and disk as bars, then the machine. Nothing when the text has no System section.
 */
function systemBody(system: Record<string, string>, top: number): { body: string; height: number } {
  if (!Object.keys(system).length) return { body: '', height: 0 };
  let y = top, body = top ? `<line x1="${PAD}" y1="${y + 8}" x2="${W - PAD}" y2="${y + 8}" stroke="${TRACK}" stroke-width="2"/>` : '';
  y += top ? 16 : 0;
  body += text('SYSTEM', PAD, y + PAD + 18, 17, MUTED, ' letter-spacing="4"');
  y += PAD + HEAD_H;
  const tiles = [
    { label: 'DATABASES', value: num(system.Databases, /^(\d+)/)?.[0], note: system.Databases?.match(/(\d+ in use)/)?.[1] },
    { label: 'WORKTREES', value: num(system.Worktrees, /^(\d+)/)?.[0] },
    { label: 'CONTAINERS', value: num(system.Containers, /^(\d+)/)?.[0] },
  ].filter((t) => t.value !== undefined);
  const tileW = (W - 2 * PAD) / Math.max(1, tiles.length);
  tiles.forEach((t, i) => {
    const x = PAD + i * tileW;
    body += text(String(t.value), x, y + 34, 36, t.value ? INK : MUTED, ' font-weight="700"');
    if (t.note) body += text(t.note, x + 26 * String(t.value).length, y + 34, 15, MUTED);
    body += text(t.label, x, y + 58, 13, MUTED, ' letter-spacing="2"');
  });
  if (tiles.length) y += TILE_H;
  const cpu = num(system.CPU, /^(\d+)%/), mem = num(system.Memory, /^(\d+) of (\d+) GB/), disk = num(system.Disk, /^(\d+) GB free of (\d+) GB/);
  const bars = [
    ...(cpu ? [{ label: 'cpu', value: `${cpu[0]}%`, pct: cpu[0]! }] : []),
    ...(mem && mem[1] ? [{ label: 'memory', value: `${mem[0]}/${mem[1]} GB`, pct: (100 * mem[0]!) / mem[1] }] : []),
    ...(disk && disk[1] ? [{ label: 'disk', value: `${disk[0]} GB free`, pct: 100 - (100 * disk[0]!) / disk[1] }] : []),
  ];
  const groupW = (W - 2 * PAD - (Math.max(1, bars.length) - 1) * GROUP_GAP) / Math.max(1, bars.length);
  bars.forEach((b, i) => {
    const x = PAD + i * (groupW + GROUP_GAP), pct = Math.max(0, Math.min(100, b.pct)), color = usageColor(pct);
    body += text(b.label, x, y + 26, 14, MUTED) + text(b.value, x + groupW, y + 26, 17, color, ' text-anchor="end" font-weight="700"');
    body += `<rect x="${x}" y="${y + 35}" width="${groupW.toFixed(1)}" height="7" rx="3.5" fill="${TRACK}"/>`;
    if (pct > 0) body += `<rect x="${x}" y="${y + 35}" width="${Math.max(7, (groupW * pct) / 100).toFixed(1)}" height="7" rx="3.5" fill="${color}"/>`;
  });
  if (bars.length) y += ROW_H;
  if (system.Machine) { body += text(clip(system.Machine, 70), PAD, y + 22, 14, MUTED); y += MACHINE_H; }
  return { body, height: y - top + 8 };
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
