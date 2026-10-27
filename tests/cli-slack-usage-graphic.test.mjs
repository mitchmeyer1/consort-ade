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
  assert.match(svg, />RESETS</); assert.match(svg, /x="616"[^>]*>Oct 28</); assert.match(svg, /x="616"[^>]*>2:30 PM</);
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
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="640" height="\d+"/);
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
  assert.equal(png.readUInt32BE(16), 1280, 'width, drawn at 2x');
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

test('a System section draws a System box to the right of the usage rows, and alone when there are no accounts', async () => {
  const { systemLines } = await import('../src/shared/slackMonitor.ts');
  const { monitorSystem } = await import('../src/cli/slackMonitorBlocks.ts');
  const lines = systemLines({ databases: 2, databasesInUse: 1, worktrees: 5, containers: 9, cpu: 35, memoryUsed: 20, memoryTotal: 48, diskFree: 480, diskTotal: 926, machine: 'Apple M5 Pro · 15 cores · macOS 26.4.1' });
  const withSystem = text.replace('\n\nOpen a ticket', `\n\n*System*\n${lines.join('\n')}\n\nOpen a ticket`);
  assert.deepEqual(monitorSystem(withSystem), { Databases: '2 sets · 1 in use', Worktrees: '5', Containers: '9 running', CPU: '35%', Memory: '20 of 48 GB', Disk: '480 GB free of 926 GB', Machine: 'Apple M5 Pro · 15 cores · macOS 26.4.1' });
  assert.equal(monitorAccounts(withSystem).length, 6, 'the System lines are not accounts');
  const g = usageGraphic(withSystem), plain = usageGraphic(text);
  for (const s of ['SYSTEM', 'DB SETS', 'WORKTREES', 'CONTAINERS', '1 used', '35%', '20/48 GB', '480 GB free', 'Apple M5 Pro']) assert.ok(g.svg.includes(s), s);
  const xOf = (svg, word) => Number(svg.match(new RegExp(`<text x="([\\d.]+)"[^>]*>${word}<`))[1]);
  assert.ok(xOf(g.svg, 'SYSTEM') > 350 && xOf(g.svg, 'USAGE') < 50, 'side by side, System on the right');
  assert.match(g.svg, /^<svg[^>]* width="640"/, 'drawn narrow so its type shows large in Slack');
  assert.match(g.alt, /System: Databases 2 sets · 1 in use; Worktrees 5/);
  assert.ok(!plain.svg.includes('SYSTEM'));
  const alone = usageGraphic(withSystem.replace(/\*Accounts\*\n[\s\S]*?\n\n/, ''));
  assert.ok(alone.svg.includes('SYSTEM') && !alone.svg.includes('USAGE'));
  const png = await usagePng(g.svg); assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const blocks = monitorBlockKit(withSystem, 0);
  assert.ok(blocks.some(b => b.type === 'context' && /\*System\*.*Worktrees 5/.test(JSON.stringify(b))), 'without the picture, one line carries the System numbers');
  const u = { fileId: 'F1', alt: 'u' }, s = { fileId: 'F2', alt: 's' };
  assert.ok(monitorBlockKit(withSystem, 0, u).some(b => /\*System\*/.test(JSON.stringify(b))), 'the usage picture alone leaves the System line');
  assert.ok(!monitorBlockKit(withSystem, 0, u, undefined, s).some(b => /\*System\*/.test(JSON.stringify(b))), 'the System picture carries them when uploaded');
  assert.ok(usageGraphic(withSystem, 'usage').svg.includes('USAGE') && !usageGraphic(withSystem, 'usage').svg.includes('SYSTEM'));
  assert.ok(usageGraphic(withSystem, 'system').svg.includes('SYSTEM') && !usageGraphic(withSystem, 'system').svg.includes('USAGE'));
  const stacked = monitorBlockKit(withSystem, 0, u, undefined, s).filter(b => b.type === 'image' && b.slack_file);
  assert.deepEqual(stacked.map(b => b.slack_file.id), ['F1', 'F2'], 'one under the other, at top level where an uploaded file renders');
});

test('CPU and memory over the last 30 minutes draw as 15 two-minute bars, with gaps where the daemon took no reading', async () => {
  const { historyBars, BUCKETS } = await import('../src/cli/systemSnapshot.ts');
  const end = Date.UTC(2026, 9, 27, 20, 0), at = (min) => end - min * 60_000;
  const samples = [{ at: at(31), cpu: 99, memory: 0 }, { at: at(29.5), cpu: 10, memory: 50 }, { at: at(29), cpu: 21, memory: 60 }, { at: at(1), cpu: 72, memory: 70 }, { at: end + 30_000, cpu: 5, memory: 5 }];
  const cpu = historyBars(samples, end + 59_000, (s) => s.cpu);
  assert.equal(cpu.length, BUCKETS);
  assert.deepEqual([cpu[0], cpu[1], cpu.at(-1)], [15, null, 70], 'oldest first, averaged and rounded to 5; the unfinished span and readings older than 30 minutes are left out');
  const { systemLines } = await import('../src/shared/slackMonitor.ts');
  const lines = systemLines({ databases: 1, databasesInUse: 0, worktrees: 2, cpu: 70, memoryUsed: 30, memoryTotal: 48, cpuHistory: cpu, memoryHistory: historyBars(samples, end + 59_000, (s) => s.memory), machine: 'M5' });
  assert.ok(lines.includes(`CPU30: 15 ${'- '.repeat(13)}70`));
  const withCharts = text.replace('\n\nOpen a ticket', `\n\n*System*\n${lines.join('\n')}\n\nOpen a ticket`);
  const g = usageGraphic(withCharts);
  assert.ok(g.svg.includes('cpu 30m') && g.svg.includes('mem 30m'));
  assert.ok(!/CPU30/.test(g.alt), 'the alt text keeps to the current numbers');
  assert.ok(!monitorBlockKit(withCharts, 0).some(b => /CPU30/.test(JSON.stringify(b))), 'the text fallback leaves the series out');
});

test('with public addresses, Usage and System are two carousel cards and nothing is uploaded or stacked', async () => {
  const { systemLines } = await import('../src/shared/slackMonitor.ts');
  const lines = systemLines({ databases: 2, databasesInUse: 1, worktrees: 5, containers: 9, cpu: 35, memoryUsed: 20, memoryTotal: 48, diskFree: 480, diskTotal: 926, machine: 'Apple M5 Pro · 15 cores · macOS 26.4.1' });
  const withSystem = text.replace('\n\nOpen a ticket', `\n\n*System*\n${lines.join('\n')}\n\nOpen a ticket`);
  const linked = { usage: { url: 'https://t.example/a/u.png', alt: 'u' }, system: { url: 'https://t.example/a/s.png', alt: 's' } };
  const blocks = monitorBlockKit(withSystem, 0, undefined, undefined, undefined, linked);
  const panels = blocks.find(b => b.block_id === 'panels-0');
  assert.deepEqual(panels.elements.map(c => [c.type, c.hero_image.image_url]), [['card', linked.usage.url], ['card', linked.system.url]]);
  assert.ok(!blocks.some(b => b.type === 'image' && b.slack_file), 'no uploaded picture');
  assert.ok(!blocks.some(b => b.type === 'data_visualization' || /\*System\*/.test(JSON.stringify(b))), 'no chart or System line beside the cards');
});

test('card pictures are 4:3, as Slack crops a card picture to 4:3', async () => {
  const { systemLines } = await import('../src/shared/slackMonitor.ts');
  const lines = systemLines({ databases: 2, databasesInUse: 1, worktrees: 5, containers: 9, cpu: 35, memoryUsed: 20, memoryTotal: 48, diskFree: 480, diskTotal: 926, machine: 'Apple M5 Pro · 15 cores · macOS 26.4.1' });
  const withSystem = text.replace('\n\nOpen a ticket', `\n\n*System*\n${lines.join('\n')}\n\nOpen a ticket`);
  for (const part of ['usage', 'system']) {
    const [, w, h] = usageGraphic(withSystem, part).svg.match(/width="(\d+)" height="(\d+)"/).map(Number);
    assert.ok(Math.abs(w / h - 4 / 3) < 0.01, `${part} is ${w}x${h}`);
  }
});
