import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as planProgress from '../src/shared/planProgress.ts';
import * as skillSections from '../src/shared/skillSections.ts';
import * as followups from '../src/shared/followups.ts';
import * as instructions from '../src/shared/instructions.ts';
const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('../src/main/agents.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(autoApprove = false) {
  const newChat = id => ({ id, worktreeId: 'wt', provider: 'claude', keyId: 'personal', model: 'model', phase: 'waiting', autoApprove, messages: [] });
  const chats = [newChat('chat'), newChat('other')];
  const [chat, other] = chats;
  const calls = [], modes = [], asked = [];
  const releases = [];
  const store = {
    data: { chats, keys: [{ id: 'personal', provider: 'claude', phiAllowed: false }], worktrees: [{ id: 'wt', path: '/nonexistent-test-worktree' }] },
    chat: id => chats.find(c => c.id === id), save() {}, getSecret: () => '',
  };
  const mocks = {
    './dockerLifecycle': { beginDockerRun: () => '', dockerRunEnvironment: () => ({}), finishDockerRun: async () => {} },
    './store': { store },
    './auth': { loginEnv: () => ({}) },
    './agentEnvironment': { TESTING_PROMPT: '', agentEnvironment: (_, env) => env, isInstallCommand: cmd => cmd === 'pnpm install' },
    './agentBrowser': { startAgentBrowser: async () => ({ prompt: '', close: async () => {} }) },
    '../shared/types': { PHASES: [] },
    '../shared/planProgress': planProgress,
    '../shared/skillSections': skillSections,
    '../shared/followups': followups,
    '../shared/instructions': instructions,
    '@openai/codex-sdk': { Codex: class {} },
    '@anthropic-ai/claude-agent-sdk': { query: args => {
      calls.push(args);
      const gate = new Promise(resolve => releases.push(resolve));
      const q = (async function* () { yield { type: 'system', subtype: 'init', session_id: 'session' }; await gate; })();
      q.setPermissionMode = async mode => { modes.push(mode); };
      return q;
    } },
    'node:child_process': { execFile: (_cmd, _args, _opts, cb) => cb(null, ''), execFileSync: () => { throw new Error('no git fixture'); } },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => mocks[name] ?? require(name), mod, mod.exports);
  mod.exports.onPermission(r => asked.push(r));
  const start = async (id = 'chat') => {
    const want = calls.length + 1;
    const done = mod.exports.send(id, 'Do the thing');
    for (let i = 0; i < 100 && calls.length < want; i++) await new Promise(r => setImmediate(r));
    assert.equal(calls.length, want);
    const release = releases[want - 1];
    return { options: calls[want - 1].options, finish: async () => { release(); await done; } };
  };
  const settle = () => new Promise(r => setImmediate(r));
  return { agents: mod.exports, chat, other, modes, asked, start, settle };
}

test('auto-approve allows tool calls without prompting', async () => {
  const f = fixture(true);
  const run = await f.start();
  assert.equal(run.options.permissionMode, 'bypassPermissions');
  assert.deepEqual(await run.options.canUseTool('Bash', { command: 'rm -rf build' }), { behavior: 'allow', updatedInput: { command: 'rm -rf build' } });
  assert.deepEqual(f.asked, []);
  assert.deepEqual(f.chat.permissions ?? [], []);
  await run.finish();
});

test('turning auto-approve on mid-run releases the open prompt and retunes the session', async () => {
  const f = fixture(false);
  const run = await f.start();
  assert.equal(run.options.permissionMode, 'acceptEdits');
  // bypass stays available for a later switch, but every call still goes through canUseTool
  assert.equal(run.options.allowDangerouslySkipPermissions, true);
  const decision = run.options.canUseTool('Bash', { command: 'docker rm consort-1' });
  await f.settle();
  assert.equal(f.asked.length, 1);
  assert.equal(f.chat.permissions.length, 1);

  f.agents.setAutoApprove('chat', true);
  assert.deepEqual(await decision, { behavior: 'allow', updatedInput: { command: 'docker rm consort-1' } });
  assert.deepEqual(f.chat.permissions, []);
  assert.deepEqual(f.modes, ['bypassPermissions']);

  // and the next call in the same run no longer asks
  assert.deepEqual(await run.options.canUseTool('Edit', { file_path: 'a.ts' }), { behavior: 'allow', updatedInput: { file_path: 'a.ts' } });
  assert.equal(f.asked.length, 1);
  await run.finish();
});

test('turning auto-approve off mid-run goes back to asking', async () => {
  const f = fixture(true);
  const run = await f.start();
  f.agents.setAutoApprove('chat', false);
  assert.deepEqual(f.modes, ['acceptEdits']);
  const decision = run.options.canUseTool('Bash', { command: 'git push' });
  await f.settle();
  assert.equal(f.asked.length, 1);
  f.agents.answerPermission(f.asked[0].id, false);
  assert.deepEqual(await decision, { behavior: 'deny', message: 'User denied' });
  await run.finish();
});

test('dependency installs still skip the prompt with auto-approve off', async () => {
  const f = fixture(false);
  const run = await f.start();
  assert.deepEqual(await run.options.canUseTool('Bash', { command: 'pnpm install' }), { behavior: 'allow', updatedInput: { command: 'pnpm install' } });
  assert.deepEqual(f.asked, []);
  await run.finish();
});

test('auto-approve on one chat leaves another chat\u2019s prompt waiting', async () => {
  const f = fixture(false);
  const run = await f.start('chat');
  const otherRun = await f.start('other');
  const decision = run.options.canUseTool('Bash', { command: 'git push' });
  const otherDecision = otherRun.options.canUseTool('Bash', { command: 'git push' });
  await f.settle();
  let otherSettled = false;
  otherDecision.then(() => (otherSettled = true));

  f.agents.setAutoApprove('chat', true);
  assert.deepEqual(await decision, { behavior: 'allow', updatedInput: { command: 'git push' } });
  await f.settle();
  assert.equal(otherSettled, false);
  assert.equal(f.other.permissions.length, 1);

  f.agents.answerPermission(f.other.permissions[0].id, false);
  assert.deepEqual(await otherDecision, { behavior: 'deny', message: 'User denied' });
  await Promise.all([run.finish(), otherRun.finish()]);
});
