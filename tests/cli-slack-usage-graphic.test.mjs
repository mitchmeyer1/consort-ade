import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageGraphic, usageSvg, usageAlt, usageColor, usagePng, resumeAt } from '../src/cli/slackUsageGraphic.ts';
import { monitorAccounts, monitorBlockKit, parseAccount } from '../src/cli/slackMonitorBlocks.ts';
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

test('a blocked account with readings keeps every bar and shows its resume time in a far-right column', () => {
  const [a] = monitorAccounts(text.replace('🔴 Claude 4 · blocked: weekly limit reached · resume after Oct 28, 2:30 PM EDT', '🔴 Claude 4 · blocked: weekly limit reached · resume after Oct 28, 2:30 PM EDT · 5-hour 12% · Weekly 100% · Weekly · Fable 40%')).filter(x => x.name === 'Claude 4');
  assert.deepEqual([a.blocked, a.detail, a.windows.map(w => w.percent)], [true, 'weekly limit reached · resume after Oct 28, 2:30 PM EDT', [12, 100, 40]]);
  const svg = usageSvg([a]), plain = usageSvg([{ ...a, blocked: false }]);
  assert.equal((svg.match(/<rect [^>]*fill="#33363b"/g) ?? []).length, 3, 'all three bars');
  assert.match(svg, />RESETS</); assert.match(svg, /x="776"[^>]*>Oct 28</); assert.match(svg, /x="776"[^>]*>2:30 PM</);
  assert.doesNotMatch(svg, /limit reached/, 'the reason stays in the alt text');
  assert.equal(svg.match(/height="(\d+)"/)[1], plain.match(/height="(\d+)"/)[1], 'no extra line');
  assert.doesNotMatch(plain, /RESETS/, 'no column without a blocked account or a reset time');
  const free = usageSvg([{ ...a, blocked: false, resets: 'Oct 30, 3:00 PM EDT' }]);
  assert.match(free, /fill="#9a9c9e" text-anchor="end">Oct 30</); assert.match(free, /font-size="14" fill="#9a9c9e" text-anchor="end">3:00 PM</, 'grey, same size as the day');
  assert.deepEqual(parseAccount('🟢 Codex 1 · available · 5-hour 4% · Weekly 9% · resets Oct 30, 3:00 PM EDT · usage 1m ago'), { name: 'Codex 1', blocked: false, status: 'Available', windows: [{ label: '5-hour', percent: 4 }, { label: 'Weekly', percent: 9 }], resets: 'Oct 30, 3:00 PM EDT', detail: '5-hour 4% · Weekly 9% · usage 1m ago' });
  assert.deepEqual(resumeAt('x · resume time unavailable'), undefined);
});

test('the panel draws a row per account with no provider headings, a coloured bar per window, and unread rows as words', () => {
  const svg = usageSvg(monitorAccounts(text));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="800" height="\d+"/);
  for (const s of ['>USAGE<', '>Claude 1<', '>Codex 2<', '>5h<', '>wk<', '>fable<', '>Oct 28<']) assert.ok(svg.includes(s), s);
  assert.doesNotMatch(svg, />CLAUDE<|>CODEX</);
  assert.doesNotMatch(svg, /ago/, 'no clock in the picture, so it only changes with the numbers');
  assert.match(svg, /fill="#e9c46a"[^>]*>77</); assert.match(svg, /fill="#f3ead6"[^>]*>49</); assert.match(svg, /fill="#f08a66"[^>]*>91</);
  assert.equal(usageColor(50), '#f3ead6'); assert.equal(usageColor(51), '#e9c46a'); assert.equal(usageColor(90), '#e9c46a'); assert.equal(usageColor(91), '#f08a66');
  assert.match(svg, />blocked · weekly limit reached</); assert.match(svg, />no reading yet</);
  assert.equal((svg.match(/<rect [^>]*fill="#33363b"/g) ?? []).length, 11, 'one track per window drawn');
  assert.match(svg, /<rect x="[\d.]+" y="\d+" width="[\d.]+" height="7" rx="3.5" fill="#e9c46a"\/>/);
  assert.match(usageAlt(monitorAccounts(text)), /^AI usage: Claude 1 5h 77%, wk 30%, fable 37%; .*Claude 4 blocked, weekly limit reached.*Codex 2 no reading$/);
  assert.equal(usageGraphic('Content withheld by guard'), undefined);
});

test('the PNG is a real image at the SVG size', async () => {
  const png = await usagePng(usageGraphic(text).svg);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 800, 'width');
});

test('with an uploaded panel the blocks show it full width in place of the chart and notes', () => {
  const blocks = monitorBlockKit(text, 1700000000000, { fileId: 'F77', alt: 'AI usage: all fine' });
  const panel = blocks.find(b => b.block_id === 'usage-1700000000000');
  assert.deepEqual(panel, { type: 'image', block_id: 'usage-1700000000000', slack_file: { id: 'F77' }, alt_text: 'AI usage: all fine' });
  assert.ok(!blocks.some(b => b.type === 'container'), 'images stay at top level: one frame, and an uploaded file renders there');
  assert.ok(!blocks.some(b => b.type === 'data_visualization'));
  assert.ok(!JSON.stringify(blocks).includes('blocked: weekly limit'), 'no notes beside the panel');
  assert.match(JSON.stringify(blocks), /_Nothing open and nothing finished yet._/);
  const chart = monitorBlockKit(text, 1700000000000);
  assert.ok(chart.some(b => b.type === 'data_visualization')); assert.match(JSON.stringify(chart), /\*Claude 4\* blocked: weekly limit reached/);
});

test('a System section draws a System box under the usage rows, and alone when there are no accounts', async () => {
  const { systemLines } = await import('../src/shared/slackMonitor.ts');
  const { monitorSystem } = await import('../src/cli/slackMonitorBlocks.ts');
  const lines = systemLines({ databases: 2, databasesInUse: 1, worktrees: 5, containers: 9, cpu: 35, memoryUsed: 20, memoryTotal: 48, diskFree: 480, diskTotal: 926, machine: 'Apple M5 Pro · 15 cores · macOS 26.4.1' });
  const withSystem = text.replace('\n\nOpen a ticket', `\n\n*System*\n${lines.join('\n')}\n\nOpen a ticket`);
  assert.deepEqual(monitorSystem(withSystem), { Databases: '2 sets · 1 in use', Worktrees: '5', Containers: '9 running', CPU: '35%', Memory: '20 of 48 GB', Disk: '480 GB free of 926 GB', Machine: 'Apple M5 Pro · 15 cores · macOS 26.4.1' });
  assert.equal(monitorAccounts(withSystem).length, 6, 'the System lines are not accounts');
  const g = usageGraphic(withSystem), plain = usageGraphic(text);
  for (const s of ['SYSTEM', 'DATABASES', 'WORKTREES', 'CONTAINERS', '1 in use', '35%', '20/48 GB', '480 GB free', 'Apple M5 Pro']) assert.ok(g.svg.includes(s), s);
  assert.ok(Number(g.svg.match(/height="(\d+)"/)[1]) > Number(plain.svg.match(/height="(\d+)"/)[1]));
  assert.match(g.alt, /System: Databases 2 sets · 1 in use; Worktrees 5/);
  assert.ok(!plain.svg.includes('SYSTEM'));
  const alone = usageGraphic(withSystem.replace(/\*Accounts\*\n[\s\S]*?\n\n/, ''));
  assert.ok(alone.svg.includes('SYSTEM') && !alone.svg.includes('USAGE'));
  const png = await usagePng(g.svg); assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const blocks = monitorBlockKit(withSystem, 0);
  assert.ok(blocks.some(b => b.type === 'context' && /\*System\*.*Worktrees 5/.test(JSON.stringify(b))), 'without the picture, one line carries the System numbers');
  assert.ok(!monitorBlockKit(withSystem, 0, { fileId: 'F1', alt: 'x' }).some(b => /\*System\*/.test(JSON.stringify(b))), 'the picture carries them when uploaded');
});
