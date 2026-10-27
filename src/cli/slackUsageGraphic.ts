/**
 * The AI usage panel as a picture, in the style of `consort-cli view`: one row per account, a thin bar per
 * limit window (5h, wk, a model's weekly) coloured by how full it is, grouped by provider. Slack's own chart
 * draws upright bars only and cannot be styled, so the monitor uploads this rendering (cli/slack.ts) and shows
 * it full width; the chart stays as the fallback when the upload is not possible.
 */
import { monitorAccounts, type AccountUsage } from './slackMonitorBlocks.ts';

// Slack shows an image block about 500px wide whatever its size. The panel is drawn 800px wide, so it stays crisp
// on a retina screen and its type and bars show 25% larger than a 1000px drawing would.
const W = 800, PAD = 24, NAME_W = 150, ROW_H = 62, NOTE_H = 34, HEAD_H = 36, GROUP_GAP = 22;
const FONT = `Menlo, 'SF Mono', Consolas, 'DejaVu Sans Mono', monospace`;
const INK = '#ece6d8', MUTED = '#9a9c9e', TRACK = '#33363b';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** White to 50%, yellow to 90%, orange above. */
export const usageColor = (percent: number) => (percent <= 50 ? '#f3ead6' : percent <= 90 ? '#e9c46a' : '#f08a66');
const short = (label: string) => (/^5-?hour$/i.test(label) ? '5h' : /^weekly$/i.test(label) ? 'wk' : label.toLowerCase().slice(0, 8));
const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s);
const text = (s: string, x: number, y: number, size: number, color: string, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}"${extra}>${esc(s)}</text>`;

/** The SVG, transparent, drawn for Slack's dark theme. Accounts group by their first word (Claude, Codex). */
export function usageSvg(accounts: AccountUsage[]): string {
  const groups = new Map<string, AccountUsage[]>();
  for (const a of accounts) { const key = a.name.split(' ')[0] ?? a.name; groups.set(key, [...(groups.get(key) ?? []), a]); }
  const columns = Math.min(4, Math.max(1, ...accounts.map((a) => a.windows.length)));
  // A blocked account with readings keeps its bars and gets a line under them for the reason and resume time.
  const noted = (a: AccountUsage) => a.blocked && a.windows.length > 0;
  const height = PAD + HEAD_H + [...groups.values()].reduce((h, rows) => h + 30 + rows.reduce((r, a) => r + ROW_H + (noted(a) ? NOTE_H : 0), 0), 0) + 10;
  const barsX = PAD + NAME_W, barsW = W - PAD - barsX, groupW = (barsW - (columns - 1) * GROUP_GAP) / columns;
  let y = PAD;
  // No clock in the picture: the footer line carries the update time, and a picture that only changes with the numbers is uploaded far less often.
  let body = text('USAGE', PAD, y + 18, 17, MUTED, ' letter-spacing="4"');
  y += HEAD_H;
  for (const [provider, rows] of groups) {
    body += text(provider.toUpperCase(), PAD, y + 18, 14, MUTED, ' letter-spacing="3"');
    y += 30;
    for (const a of rows) {
      body += text(clip(a.name, 12), PAD, y + 36, 21, INK, ' font-weight="600"');
      if (noted(a)) body += text(clip(`blocked · ${a.detail}`, 82), PAD, y + ROW_H + 14, 15, usageColor(100));
      if (a.blocked && !a.windows.length) body += text(clip(`blocked · ${a.detail}`, 70), barsX, y + 35, 14, usageColor(100));
      else if (!a.windows.length) body += text(clip(a.detail === 'no reading yet' ? 'no reading yet' : `no reading · ${a.detail}`, 62), barsX, y + 35, 15, MUTED);
      else a.windows.slice(0, columns).forEach((w, i) => {
        const x = barsX + i * (groupW + GROUP_GAP), pct = Math.max(0, Math.min(100, w.percent)), color = usageColor(pct);
        body += text(short(w.label), x, y + 26, 14, MUTED) + text(String(w.percent), x + groupW, y + 26, 17, color, ' text-anchor="end" font-weight="700"');
        body += `<rect x="${x}" y="${y + 35}" width="${groupW}" height="7" rx="3.5" fill="${TRACK}"/>`;
        if (pct > 0) body += `<rect x="${x}" y="${y + 35}" width="${Math.max(7, (groupW * pct) / 100).toFixed(1)}" height="7" rx="3.5" fill="${color}"/>`;
      });
      y += ROW_H + (noted(a) ? NOTE_H : 0);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="${FONT}">${body}</svg>`;
}

/** Plain words for the image's alt text. */
export function usageAlt(accounts: AccountUsage[]): string {
  return 'AI usage: ' + accounts.map((a) => `${a.name} ${a.blocked ? `blocked, ${a.detail}` : a.windows.length ? a.windows.map((w) => `${short(w.label)} ${w.percent}%`).join(', ') : 'no reading'}`).join('; ');
}

/** The panel for a master monitor text, or undefined when it lists no accounts. */
export function usageGraphic(safe: string): { svg: string; alt: string } | undefined {
  const accounts = monitorAccounts(safe);
  if (!accounts.length) return undefined;
  return { svg: usageSvg(accounts), alt: usageAlt(accounts) };
}

/** PNG at 1x of the SVG's size; the native rasterizer loads only here, so the rest of the CLI never needs it. */
export async function usagePng(svg: string): Promise<Buffer> {
  const { Resvg } = await import('@resvg/resvg-js');
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Menlo' } }).render().asPng());
}
