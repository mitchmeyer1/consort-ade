import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageGraphic, usageSvg, usageAlt, usageColor, usagePng } from '../src/cli/slackUsageGraphic.ts';
import { monitorAccounts, monitorBlockKit } from '../src/cli/slackMonitorBlocks.ts';
const text = `*📊 Consort master monitor*
Updated 2026-10-27 16:45 UTC

*Working*
No tasks in progress.

*Ready to merge · your action*
No tickets waiting to be merged.

*Completed · most recent 6*
No completed tasks yet.

*Accounts*
🟡 Claude 1 · available · 5-hour 77% · Weekly 30% · Weekly · Fable 37% · usage 1m ago
🟢 Claude 2 · available · 5-hour 49% · Weekly 24% · Weekly · Fable 29% · usage 1m ago
🟠 Claude 3 · available · 5-hour 91% · Weekly 30% · Weekly · Fable 40% · usage 1m ago
🔴 Claude 4 · blocked: weekly limit reached · resume after Oct 28, 2:30 PM EDT
🟢 Codex 1 · available · 5-hour 64% · Weekly 39% · usage 1m ago
⚪ Codex 2 · usage unavailable

Open a ticket title to reply in its Slack thread. This monitor updates in place; ticket discussions stay in their own threads.

STATUS: MONITORING`;

test('accounts parse out of the monitor text with every window', () => {
  const accounts = monitorAccounts(text);
  assert.deepEqual(accounts.map(a => [a.name, a.blocked, a.windows.map(w => `${w.label} ${w.percent}`)]), [
    ['Claude 1', false, ['5-hour 77', 'Weekly 30', 'Fable 37']], ['Claude 2', false, ['5-hour 49', 'Weekly 24', 'Fable 29']], ['Claude 3', false, ['5-hour 91', 'Weekly 30', 'Fable 40']],
    ['Claude 4', true, []], ['Codex 1', false, ['5-hour 64', 'Weekly 39']], ['Codex 2', false, []]]);
  assert.deepEqual(monitorAccounts('Content withheld by guard'), []);
});

test('the panel draws provider groups, a row per account, a coloured bar per window, and blocked or unread rows as words', () => {
  const svg = usageSvg(monitorAccounts(text));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1600" height="\d+"/);
  for (const s of ['>USAGE<', '>CLAUDE<', '>CODEX<', '>Claude 1<', '>Codex 2<', '>5h<', '>wk<', '>fable<', '>updated 1m ago<']) assert.ok(svg.includes(s), s);
  assert.match(svg, /fill="#e9c46a"[^>]*>77</); assert.match(svg, /fill="#f3ead6"[^>]*>49</); assert.match(svg, /fill="#f08a66"[^>]*>91</);
  assert.equal(usageColor(50), '#f3ead6'); assert.equal(usageColor(51), '#e9c46a'); assert.equal(usageColor(90), '#e9c46a'); assert.equal(usageColor(91), '#f08a66');
  assert.match(svg, />blocked · weekly limit reached · resume after Oct 28, 2:30 PM EDT</); assert.match(svg, />no reading yet</);
  assert.equal((svg.match(/<rect [^>]*fill="#33363b"/g) ?? []).length, 11, 'one track per window drawn');
  assert.match(svg, /<rect x="[\d.]+" y="\d+" width="[\d.]+" height="10" rx="5" fill="#e9c46a"\/>/);
  assert.match(usageAlt(monitorAccounts(text)), /^AI usage: Claude 1 5h 77%, wk 30%, fable 37%; .*Claude 4 blocked, weekly limit reached.*Codex 2 no reading$/);
  assert.equal(usageGraphic('Content withheld by guard'), undefined);
});

test('the PNG is a real image at the SVG size', async () => {
  const png = await usagePng(usageGraphic(text).svg);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1600, 'width');
});

test('with an uploaded panel the blocks show it full width in place of the chart and notes', () => {
  const blocks = monitorBlockKit(text, 1700000000000, { fileId: 'F77', alt: 'AI usage: all fine' });
  const panel = blocks.find(b => b.block_id === 'usage-1700000000000');
  assert.deepEqual(panel, { type: 'container', block_id: 'usage-1700000000000', title: { type: 'plain_text', text: ' ' }, width: 'full', has_header_divider: false, child_blocks: [{ type: 'image', slack_file: { id: 'F77' }, alt_text: 'AI usage: all fine' }] });
  assert.ok(!blocks.some(b => b.type === 'data_visualization'));
  assert.ok(!JSON.stringify(blocks).includes('blocked: weekly limit'), 'no notes beside the panel');
  assert.match(JSON.stringify(blocks), /_Nothing open and nothing finished yet._/);
  const chart = monitorBlockKit(text, 1700000000000);
  assert.ok(chart.some(b => b.type === 'data_visualization')); assert.match(JSON.stringify(chart), /\*Claude 4\* blocked: weekly limit reached/);
});
