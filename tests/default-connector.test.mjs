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
