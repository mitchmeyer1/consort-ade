import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as seatPool from '../src/shared/seatPool.ts';
import { slackMessage, slackStatus } from '../src/shared/headless.ts';
const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL('../src/cli/agent.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/import\.meta\.url/g, '"file:///virtual/cli/agent.js"');
function load(runStreamed, onStart = () => {}, onNew = () => {}) {
  const mocks = {
    './state': { HOME: '/virtual' }, '../shared/seatPool.ts': seatPool,
    '../main/cliRuntime': { cliBinary: () => '/virtual/codex' },
    '@openai/codex-sdk': { Codex: class { constructor(o) { onNew(o); } startThread(o) { onStart(o); return { runStreamed }; } } },
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


test('reader turns set read-only sandbox and explicit effort', async () => {
  let options;
  const agent = load(async () => ({ events: (async function* () { yield { type: 'turn.completed', usage: {} }; })() }), o => { options = o; });
  await agent.runTurn({ ...opts, readOnly: true, effort: 'low' });
  assert.equal(options.sandboxMode, 'read-only');
  assert.equal(options.modelReasoningEffort, 'low');
  assert.equal(options.approvalPolicy, 'never');
});

test('cancelling one parallel turn leaves the other running', async () => {
  let ready, finish;
  const started = new Promise(r => { ready = r; });
  const release = new Promise(r => { finish = r; });
  const signals = [];
  const agent = load(async (_, { signal }) => ({ events: (async function* () {
    signals.push(signal);
    if (signals.length === 2) ready();
    await Promise.race([release, new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))]);
    yield { type: 'turn.completed', usage: {} };
  })() }));
  const first = new AbortController();
  const a = agent.runTurn({ ...opts, signal: first.signal });
  const b = agent.runTurn(opts);
  try {
    await started;
    first.abort();
    assert.equal((await a).error, 'aborted');
    assert.equal(signals[1].aborted, false);
    finish();
    assert.equal((await b).error, undefined);
  } finally { finish(); agent.stopAgents(); await Promise.allSettled([a, b]); }
});

test('review SDK configuration pins a cheap reader and limits spawned agents', async () => {
  let config;
  const agent = load(async () => ({ events: (async function* () {})() }), () => {}, o => { config = o.config; });
  await agent.runTurn({ ...opts, maxDelegates: 1, delegateModel: 'gpt-5.6-luna' });
  assert.equal(config.agents.enabled, true);
  assert.equal(config.agents.max_concurrent_threads_per_session, 1);
  assert.equal(config.agents.default_subagent_model, 'gpt-5.6-luna');
  assert.equal(config.agents.default_subagent_reasoning_effort, 'low');
  await agent.runTurn(opts);
  assert.equal(config.agents.enabled, false);
});

test('Claude reader budget denies background and overlapping delegates and releases failed readers', async () => {
  const { delegateBudget } = load(async () => ({}));
  const hooks = delegateBudget(1);
  const before = hooks.PreToolUse[0].hooks[0];
  const after = hooks.PostToolUseFailure[0].hooks[0];
  const event = { hook_event_name: 'PreToolUse', tool_input: {} };
  assert.deepEqual(await before(event, 'first', {}), {});
  assert.equal((await before(event, 'second', {})).hookSpecificOutput.permissionDecision, 'deny');
  await after({}, 'first', {});
  assert.deepEqual(await before(event, 'second', {}), {});
  await after({}, 'second', {});
  assert.equal((await before({ ...event, tool_input: { run_in_background: true } }, 'background', {})).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await delegateBudget(0).PreToolUse[0].hooks[0](event, 'none', {})).hookSpecificOutput.permissionDecision, 'deny');
});
