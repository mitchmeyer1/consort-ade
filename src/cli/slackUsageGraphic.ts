/**
 * The AI usage panel as a picture, in the style of `consort-cli view`: one row per account, a thin bar per
 * limit window (5h, wk, a model's weekly) coloured by how full it is, and a blocked account's resume time. Slack's own chart
 * draws upright bars only and cannot be styled, so the monitor uploads this rendering (cli/slack.ts) and shows
 * it full width; the chart stays as the fallback when the upload is not possible.
 */
import { monitorAccounts, type AccountUsage } from './slackMonitorBlocks.ts';

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
export function usageSvg(accounts: AccountUsage[]): string {
  const columns = Math.min(4, Math.max(1, ...accounts.map((a) => a.windows.length)));
  const resumeW = accounts.some((a) => a.blocked || a.resets) ? RESUME_W : 0;
  const height = PAD + HEAD_H + accounts.length * ROW_H + 4;
  const barsX = PAD + NAME_W, barsW = W - PAD - barsX - resumeW, groupW = (barsW - (columns - 1) * GROUP_GAP) / columns;
  let y = PAD;
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
