import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scannerLines, slackMasterMonitor } from '../src/shared/slackMonitor.ts';
import { monitorBlockKit, monitorScanners } from '../src/cli/slackMonitorBlocks.ts';

const NOW = Date.UTC(2026, 9, 28, 16, 0);
const rows = [
  { name: 'Aligned Marketplace', kind: 'ClickUp', on: true, everyMinutes: 1, open: 2, limit: 16, turns: 4, lastScanAt: NOW - 60_000 },
  { name: 'Sentry → ClickUp', kind: 'Sentry', on: false, everyMinutes: 15, open: 1, limit: 1, turns: 1 },
];

test('the Scanners section lists each scanner and becomes a table below usage', () => {
  assert.deepEqual(scannerLines(rows, NOW), ['Aligned Marketplace · ClickUp · on · every 1m · 2/16 tickets · 4 AI turns · scanned 1m ago', 'Sentry → ClickUp · Sentry · off · every 15m · 1/1 tickets · 1 AI turns · not scanned yet']);
  const state = { accounts: [], jobs: [], tasks: [] };
  const text = slackMasterMonitor(state, new Map(), NOW, () => false, new Map(), new Map(), undefined, rows);
  assert.equal(monitorScanners(text).length, 2);
  const blocks = monitorBlockKit(text, NOW);
  const i = blocks.findIndex(b => b.type === 'table' && b.block_id === `scanners-${NOW}`);
  assert.ok(i > 0, 'a scanners table');
  const cells = blocks[i].rows.map(r => r.map(c => c.text ?? c.elements[0].elements.map(e => e.text).join('')));
  assert.deepEqual(cells[0], ['Scanner', 'Kind', 'State', 'Scans', 'Tickets open', 'AI turns', 'Last scan']);
  assert.deepEqual(cells[1], ['Aligned Marketplace', 'ClickUp', '🟢 on', 'every 1m', '2/16', '4', '1m ago']);
  assert.deepEqual(cells[2].slice(2), ['⚪ off', 'every 15m', '1/1', '1', 'not scanned yet']);
  assert.match(JSON.stringify(blocks[i - 1]), /\*Scanners\*/);
  assert.ok(!slackMasterMonitor(state, new Map(), NOW, () => false).includes('*Scanners*'), 'no section without scanners');
});
