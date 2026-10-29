/**
 * The monitor's head as a picture: the Consort mark and word on the left, and on the right how many tasks sit in
 * each open group, zeros included, so the state reads at a glance before the cards. Uploaded like the usage panel
 * (cli/slack.ts); when it cannot be, the static banner stands in.
 */
import { readFileSync } from 'node:fs';
import { monitorCounts } from './slackMonitorBlocks.ts';

// Drawn at 800px like the usage panel, so both shrink alike to the width Slack gives an image block.
const W = 800, H = 112, PAD = 24, LOGO_H = 56, LOGO_W = Math.round((LOGO_H * 880) / 200);
const FONT = `Menlo, 'SF Mono', Consolas, 'DejaVu Sans Mono', monospace`;
const MUTED = '#9a9c9e', ZERO = '#5c5f63';
const STATES = [
  { key: 'reply', label: 'REPLY', color: '#f08a66' },
  { key: 'nudge', label: 'NUDGE', color: '#e9c46a' },
  { key: 'ready', label: 'READY', color: '#8fd19e' },
  { key: 'working', label: 'WORKING', color: '#ece6d8' },
] as const;
type Counts = Record<(typeof STATES)[number]['key'], number>;

let wordmark: string | undefined;
/** The white mark and word (build/consort-wordmark-white.png, 880x200) as a data URI; the path holds from src/cli and out/cli alike. */
function logo(): string {
  return (wordmark ??= `data:image/png;base64,${readFileSync(new URL('../../build/consort-wordmark-white.png', import.meta.url)).toString('base64')}`);
}

/** The SVG, transparent, drawn for Slack's dark theme. */
export function headSvg(counts: Counts): string {
  const tilesX = PAD + LOGO_W + 48, tileW = (W - PAD - tilesX) / STATES.length;
  let body = `<image x="${PAD}" y="${(H - LOGO_H) / 2}" width="${LOGO_W}" height="${LOGO_H}" href="${logo()}"/>`;
  STATES.forEach((s, i) => {
    const cx = (tilesX + tileW * i + tileW / 2).toFixed(1), n = counts[s.key];
    body += `<text x="${cx}" y="64" font-size="40" font-weight="700" text-anchor="middle" fill="${n ? s.color : ZERO}">${n}</text>`;
    body += `<text x="${cx}" y="88" font-size="13" letter-spacing="2" text-anchor="middle" fill="${n ? MUTED : ZERO}">${s.label}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">${body}</svg>`;
}

/** Plain words for the image's alt text. */
export const headAlt = (counts: Counts) => `Consort: ${STATES.map((s) => `${counts[s.key]} ${s.label.toLowerCase()}`).join(', ')}`;

/** The head for a master monitor text, or undefined for any other text. */
export function headGraphic(safe: string): { svg: string; alt: string } | undefined {
  const counts = monitorCounts(safe);
  return counts ? { svg: headSvg(counts), alt: headAlt(counts) } : undefined;
}

/** PNG at 2x of the SVG's size, so a retina screen shows it sharp; the native rasterizer loads only here, so the rest of the CLI never needs it. */
export async function headPng(svg: string): Promise<Buffer> {
  const { Resvg } = await import('@resvg/resvg-js');
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 }, font: { loadSystemFonts: true, defaultFontFamily: 'Menlo' } }).render().asPng());
}
