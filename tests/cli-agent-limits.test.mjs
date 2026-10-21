import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as seatPool from '../src/shared/seatPool.ts';
import { slackMessage, slackStatus } from '../src/shared/headless.ts';
const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL('../src/cli/agent.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/import\.meta\.url/g, '"file:///virtual/cli/agent.js"');
function load(runStreamed) {
  const mocks = {
    './state': { HOME: '/virtual' }, '../shared/seatPool.ts': seatPool,
    '../main/cliRuntime': { cliBinary: () => '/virtual/codex' },
    '@openai/codex-sdk': { Codex: class { startThread() { return { runStreamed }; } } },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(n => mocks[n] ?? require(n), mod, mod.exports);
  return mod.exports;
}
const opts = { cwd: '/virtual', prompt: 'work', model: 'codex', account: { provider: 'codex', auth: 'key' } };

test('stopAgents aborts an active Codex stream', async () => {
  let started;
  const ready = new Promise(r => { started = r; });
  let signal;
  const agent = load(async (_, options) => {
    signal = options.signal;
    return { events: (async function* () {
      started();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    })() };
  });
  const turn = agent.runTurn(opts);
  await ready;
  agent.stopAgents();
  const result = await turn;
  assert.equal(signal.aborted, true);
  assert.equal(result.error, 'aborted');
});

test('Codex terminal quota errors return immediately instead of waiting on the stream', async () => {
  let readPastError = false;
  const agent = load(async () => ({ events: (async function* () {
    yield { type: 'turn.failed', error: { message: "You've hit your usage limit" } };
    readPastError = true;
  })() }));
  const result = await agent.runTurn(opts);
  assert.ok(result.limit);
  assert.equal(readPastError, false);
});

test('Slack replies always stay inside the ticket thread', async () => {
  const source = ts.transpileModule(readFileSync(new URL('../src/cli/slack.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', source)(() => ({ slackMessage, slackStatus }), mod, mod.exports);
  let body;
  const slack = new mod.exports.Slack({ botToken: 'test', channel: 'C1' }, async (_, init) => { body = new URLSearchParams(init.body); return { json: async () => ({ ok: true, ts: '2' }) }; });
  for (const [text, status] of [['Paused', 'WAITING'], ['Resumed', 'RUNNING'], ['Question?', 'WAITING'], ['Completed', 'COMPLETED'], ['Worker exited', 'STOPPED'], ['Routine progress', 'RUNNING']]) {
    await slack.post(slackStatus(text, status), '1');
    assert.ok(body.get('text').endsWith(`\n\nSTATUS: ${status}`));
    assert.equal(body.get('text').match(/STATUS:/g).length, 1);
    assert.equal(body.get('thread_ts'), '1');
    assert.equal(body.has('reply_broadcast'), false);
  }
  const headed = slackStatus('✅ Watching the PR', 'WAITING', { ticket: 'https://ticket/1', github: 'https://github.com/a/b/pull/1', heading: '🗺️ Create new locations map' });
  await slack.post(headed, '1');
  assert.equal(body.get('text'), headed);
  await slack.post('Picked up a ticket');
  assert.equal(body.get('text'), '✅ Picked up a ticket\n\nSTATUS: RUNNING');
  assert.equal(body.has('thread_ts'), false);
  assert.equal(body.has('reply_broadcast'), false);
});
