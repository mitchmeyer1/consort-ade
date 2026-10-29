import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scannerLines, slackMasterMonitor } from '../src/shared/slackMonitor.ts';
import { monitorBlockKit, monitorScanners } from '../src/cli/slackMonitorBlocks.ts';

const NOW = Date.UTC(2026, 9, 28, 16, 0);
const rows = [
  { name: 'Aligned Marketplace', kind: 'ClickUp', criteria: 'tag ai-handle-mitch; status to do', on: true, everyMinutes: 1, open: 2, limit: 16, turns: 4, lastScanAt: NOW - 60_000 },
  { name: 'Sentry → ClickUp', kind: 'Sentry', on: false, everyMinutes: 15, open: 1, limit: 1, turns: 1 },
];

test('the Scanners section lists each scanner and becomes a table below usage', () => {
  assert.deepEqual(scannerLines(rows, NOW), ['Aligned Marketplace · ClickUp · tag ai-handle-mitch; status to do · on · every 1m · 2/16 tickets · 4 AI turns · scanned 1m ago', 'Sentry → ClickUp · Sentry · — · off · every 15m · 1/1 tickets · 1 AI turns · not scanned yet']);
  const state = { accounts: [], jobs: [], tasks: [] };
  const text = slackMasterMonitor(state, new Map(), NOW, () => false, new Map(), new Map(), undefined, rows);
  assert.equal(monitorScanners(text).length, 2);
  const blocks = monitorBlockKit(text, NOW);
  const i = blocks.findIndex(b => b.type === 'table' && b.block_id === `scanners-${NOW}`);
  assert.ok(i > 0, 'a scanners table');
  const cells = blocks[i].rows.map(r => r.map(c => c.text ?? c.elements[0].elements.map(e => e.text).join('')));
  assert.deepEqual(cells[0], ['Scanner', 'Kind', 'Criteria', 'State', 'Scans', 'Tickets open', 'AI turns', 'Last scan']);
  assert.deepEqual(cells[1], ['Aligned Marketplace', 'ClickUp', 'tag ai-handle-mitch; status to do', '🟢 on', 'every 1m', '2/16', '4', '1m ago']);
  assert.deepEqual(cells[2].slice(3), ['⚪ off', 'every 15m', '1/1', '1', 'not scanned yet']);
  assert.match(JSON.stringify(blocks[i - 1]), /\*Scanners\*/);
  assert.ok(!slackMasterMonitor(state, new Map(), NOW, () => false).includes('*Scanners*'), 'no section without scanners');
});

test('criteria name each scanner\'s filters, reviewer or Sentry projects', async () => {
  const { scannerCriteria } = await import('../src/shared/scannerCriteria.ts');
  assert.equal(scannerCriteria({ source: 'clickup', filters: { tags: ['ai-handle-mitch'], statuses: ['to do'] } }), 'tag ai-handle-mitch; status to do');
  assert.equal(scannerCriteria({ source: 'review', reviewer: 'mitchmeyer1', filters: {} }), 'PRs for @mitchmeyer1');
  assert.equal(scannerCriteria({ source: 'sentry', filters: {}, sentry: { projects: ['node'], environments: ['production'], query: 'is:unresolved' } }), 'project node; env production; is:unresolved');
  assert.equal(scannerCriteria({ source: 'clickup', filters: {} }), 'everything');
});

test('System is a one-row table after AI usage, with CPU and memory peaks over 30 minutes', async () => {
  const { systemLines } = await import('../src/shared/slackMonitor.ts');
  const system = { databases: 2, databasesInUse: 1, worktrees: 5, containers: 9, cpu: 35, memoryUsed: 20, memoryTotal: 48, cpuHistory: [null, 10, 60], memoryHistory: [40, 45], diskFree: 480, diskTotal: 926, machine: 'Apple M5 Pro · 15 cores · macOS 26.4.1' };
  const text = slackMasterMonitor({ accounts: [], jobs: [], tasks: [] }, new Map(), NOW, () => false, new Map(), new Map(), system, rows);
  assert.ok(systemLines(system).length > 0);
  const blocks = monitorBlockKit(text, NOW);
  const t = blocks.find(b => b.block_id === `system-${NOW}`);
  const cells = t.rows.map(r => r.map(c => c.text ?? c.elements[0].elements.map(e => e.text).join('')));
  assert.deepEqual(cells[0], ['DB sets', 'Worktrees', 'Containers', 'CPU', 'Memory', 'Disk', 'Machine']);
  assert.deepEqual(cells[1], ['2 sets · 1 in use', '5', '9 running', '35% · peak 60%', '20/48 GB · peak 45%', '480 GB free of 926 GB', 'Apple M5 Pro · 15 cores · macOS 26.4.1']);
  assert.ok(blocks.findIndex(b => b.block_id === `system-${NOW}`) < blocks.findIndex(b => b.block_id === `scanners-${NOW}`), 'System comes before Scanners');
  assert.ok(!blocks.some(b => b.type === 'image' && b.block_id !== undefined && /usage|system|panels/.test(b.block_id)), 'no pictures for usage or System');
});
