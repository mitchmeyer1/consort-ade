import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { scanCountdown, replyAfter, slackMessage, slackStatus } from '../src/shared/headless.ts';
const require = createRequire(import.meta.url);
const compile = file => ts.transpileModule(readFileSync(new URL(`../src/cli/${file}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

test('scanner countdown shows seconds, due, scanning elapsed, and disabled states', () => {
  const job = { enabled: true, everyMinutes: 1, lastScanAt: 100000 };
  assert.equal(scanCountdown(job, 130000), 'next scan in 00:30');
  assert.equal(scanCountdown(job, 159001), 'next scan in 00:01');
  assert.equal(scanCountdown(job, 160000), 'due now');
  assert.equal(scanCountdown(job, 170000), 'due now');
  assert.equal(scanCountdown({ ...job, lastScanAt: undefined }, 130000), 'due now');
  assert.equal(scanCountdown({ ...job, enabled: false }, 130000), 'off');
  assert.equal(scanCountdown({ ...job, scanStartedAt: 160000 }, 163000), 'scanning · 00:03 elapsed');
  assert.equal(scanCountdown({ ...job, scanStartedAt: 90000 }, 130000), 'next scan in 00:30', 'finished scans must not stay scanning');
  assert.equal(scanCountdown({ ...job, everyMinutes: 5 }, 130000), 'next scan in 04:30');
});

test('shared status journal returns only eight newest entries across writers and ignores damaged lines', t => {
  const root = mkdtempSync(join(tmpdir(), 'consort-status-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const load = () => {
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', compile('statusLog'))(n => n === './state' ? { LOG_DIR: root } : require(n), mod, mod.exports);
    return mod.exports;
  };
  const a = load(), b = load();
  assert.deepEqual(a.recentStatusEvents(), []);
  for (let i = 0; i < 12; i++) (i % 2 ? a : b).statusEvent(i % 2 ? 'success' : 'info', `Ticket ${i}: checked`, 1000 + i);
  appendFileSync(join(root, 'status.jsonl'), 'not json\n');
  const events = a.recentStatusEvents();
  assert.equal(events.length, 8);
  assert.equal(events[0].text, 'Ticket 4: checked');
  assert.equal(events.at(-1).text, 'Ticket 11: checked');
  assert.equal(events.at(-1).tone, 'success');
  b.statusEvent('warn', '\x1b[31mNo Slack answer\nnext line\x00', 2000);
  assert.equal(a.recentStatusEvents().at(-1).text, 'No Slack answer next line');
});

test('status journal reads the tail of a large log', t => {
  const root = mkdtempSync(join(tmpdir(), 'consort-status-tail-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compile('statusLog'))(n => n === './state' ? { LOG_DIR: root } : require(n), mod, mod.exports);
  appendFileSync(join(root, 'status.jsonl'), 'x'.repeat(40000) + '\n');
  mod.exports.statusEvent('error', 'Scanner failed; retrying', 1000);
  assert.equal(mod.exports.recentStatusEvents().at(-1).text, 'Scanner failed; retrying');
});

test('Slack polling reports empty, failed, and answered checks without exposing reply text', async () => {
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'setTimeout', compile('slack'))(() => ({ replyAfter, slackMessage, slackStatus }), mod, mod.exports, fn => fn());
  let checks = 0;
  const slack = new mod.exports.Slack({ channel: 'C1', userId: 'owner', botToken: 'test' }, async () => ({ json: async () => {
    checks++;
    if (checks === 2) throw new Error('connection failed');
    return { ok: true, messages: checks === 3 ? [{ user: 'owner', ts: '3', text: 'Private owner answer' }] : [] };
  } }));
  const results = [];
  const answer = await slack.waitForReply('1', '2', { onCheck: result => results.push(result), pollMs: 1 });
  assert.equal(answer, 'Private owner answer');
  assert.deepEqual(results, ['empty', 'error', 'answer']);
  assert.ok(!JSON.stringify(results).includes(answer));
});
