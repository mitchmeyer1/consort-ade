import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(await readFile(new URL('../src/main/agents.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick(); }
  assert.fail('Queue did not reach the expected state');
}
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'consort-queue-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd });
  const chat = { id: 'chat', worktreeId: 'wt', provider: 'codex', keyId: 'key', phase: 'waiting', running: false, messages: [] };
  const runs = [];
  const thread = { runStreamed: async (prompt, { signal }) => {
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    signal.addEventListener('abort', () => finish(), { once: true });
    runs.push({ prompt, finish });
    return { events: (async function* () { const event = await done; if (event) yield event; })() };
  } };
  const store = { data: { chats: [chat], keys: [{ id: 'key', phiAllowed: true }], worktrees: [{ id: 'wt', path: cwd }] }, chat: () => chat, getSecret: () => 'fake', save() {} };
  const mocks = {
    './store': { store },
    './agentBrowser': { startAgentBrowser: async () => ({ prompt: '', close: async () => {} }) },
    './agentEnvironment': { TESTING_PROMPT: '', agentEnvironment: (_, env) => env },
    '../shared/types': { PHASES: ['waiting', 'planning', 'executing', 'validating', 'complete'] },
    '@anthropic-ai/claude-agent-sdk': {},
    '@openai/codex-sdk': { Codex: class { startThread() { return thread; } resumeThread() { return thread; } } },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => mocks[name] ?? require(name), mod, mod.exports);
  return { agents: mod.exports, chat, runs, cwd };
}

test('messages submitted during a run execute once in FIFO order, with independent attachments', async t => {
  const { agents, chat, runs, cwd } = await fixture(t);
  await agents.send(chat.id, 'first');
  await until(() => runs.length === 1);
  const file = join(cwd, 'note.txt');
  await writeFile(file, 'second attachment');
  await agents.send(chat.id, 'second', [file]);
  await writeFile(file, 'third attachment');
  await agents.send(chat.id, 'third', [file]);
  assert.equal(runs.length, 1);
  assert.deepEqual(chat.queuedMessages.map(m => m.text), ['second', 'third']);
  const paths = chat.queuedMessages.map(m => m.files[0]);
  assert.equal(await readFile(paths[0], 'utf8'), 'second attachment');
  assert.equal(await readFile(paths[1], 'utf8'), 'third attachment');
  runs[0].finish();
  await until(() => runs.length === 2);
  assert.match(runs[1].prompt, /second/);
  runs[1].finish();
  await until(() => runs.length === 3);
  assert.match(runs[2].prompt, /third/);
  runs[2].finish();
  await until(() => !chat.running);
  assert.equal(chat.queuedMessages.length, 0);
  assert.equal(chat.messages.filter(m => m.role === 'user').length, 3);
});

test('Stop pauses pending messages until explicitly resumed', async t => {
  const { agents, chat, runs } = await fixture(t);
  await agents.send(chat.id, 'first');
  await until(() => runs.length === 1);
  await agents.send(chat.id, 'later');
  agents.stop(chat.id);
  await until(() => !chat.running);
  assert.equal(chat.queuePaused, true);
  assert.equal(chat.queuedMessages.length, 1);
  await agents.flushQueued(chat.id);
  assert.equal(runs.length, 1);
  chat.queuePaused = false;
  const draining = agents.flushQueued(chat.id);
  await until(() => runs.length === 2);
  runs[1].finish();
  await draining;
  assert.equal(chat.queuedMessages.length, 0);
});

test('a provider failure retains and pauses queued follow-ups', async t => {
  const { agents, chat, runs } = await fixture(t);
  await agents.send(chat.id, 'first');
  await until(() => runs.length === 1);
  await agents.send(chat.id, 'later');
  runs[0].finish({ type: 'turn.failed', error: { message: 'provider unavailable' } });
  await until(() => !chat.running);
  assert.equal(chat.error, 'provider unavailable');
  assert.equal(chat.queuePaused, true);
  assert.equal(chat.queuedMessages[0].text, 'later');
  assert.equal(runs.length, 1);
});
