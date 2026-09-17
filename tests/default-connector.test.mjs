import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConnector } from '../src/shared/defaultConnector.ts';

const keys = [
  { id: 'claude-built-in', provider: 'claude', auth: 'login' },
  { id: 'codex-work', provider: 'codex', auth: 'login', configDir: '/work/login' },
  { id: 'claude-api', provider: 'claude', auth: 'key' },
];
test('explicit default overrides provider and list order, including after settings reload', () => {
  for (const key of keys) {
    const state = JSON.parse(JSON.stringify({ keys, defaultKeyId: key.id }));
    assert.equal(defaultConnector(state).id, key.id);
  }
});
test('legacy settings and removed defaults fall back to Claude, then any remaining connector', () => {
  assert.equal(defaultConnector({ keys }).id, 'claude-built-in');
  assert.equal(defaultConnector({ keys, defaultKeyId: 'removed' }).id, 'claude-built-in');
  assert.equal(defaultConnector({ keys: [keys[1]], defaultKeyId: 'removed' }).id, 'codex-work');
  assert.equal(defaultConnector({ keys: [] }), undefined);
});

test('reviews resolve both the default connector and its remembered model after reload', async () => {
  const { selectedModel } = await import('../src/shared/defaultConnector.ts');
  const state = JSON.parse(JSON.stringify({ keys: keys.map(k => ({ ...k, defaultModel: k.id === 'codex-work' ? 'custom-codex-model' : 'claude-opus-5' })), defaultKeyId: 'codex-work', chats: [] }));
  const key = defaultConnector(state);
  assert.equal(key.id, 'codex-work');
  assert.equal(selectedModel(state, key, 'provider-first'), 'custom-codex-model');
});

test('legacy model selection uses the latest matching connector chat and preserves provider isolation', async () => {
  const { selectedModel } = await import('../src/shared/defaultConnector.ts');
  const state = { chats: [
    { keyId: 'claude-api', provider: 'claude', model: 'old-model', messages: [{ts: 10}] },
    { keyId: 'claude-api', provider: 'claude', model: 'chosen-model', messages: [{ts: 20}] },
    { keyId: 'claude-built-in', provider: 'claude', model: 'other-account', messages: [{ts: 100}] },
    { keyId: 'codex-work', provider: 'codex', model: 'other-provider', messages: [{ts: 200}] },
  ] };
  assert.equal(selectedModel(state, keys[2], 'provider-first'), 'chosen-model');
  assert.equal(selectedModel(state, { ...keys[2], defaultModel: 'explicit-choice' }, 'provider-first'), 'explicit-choice');
  assert.equal(selectedModel({ chats: [] }, keys[2], 'provider-first'), 'provider-first');
});
