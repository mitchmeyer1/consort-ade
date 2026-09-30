import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeClaudeModels, normalizeClaudeModels } from '../src/shared/claudeModels.ts';

test('the CLI\'s alias rows become wire ids, once each, in the CLI\'s order', () => {
  const rows = [
    { value: 'default', resolvedModel: 'claude-opus-5[1m]' },
    { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]' },
    { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5' },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
  ];
  assert.deepEqual(normalizeClaudeModels(rows), ['claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
});

test('a row with no resolution keeps its value if it is a wire id, and aliases alone are dropped', () => {
  assert.deepEqual(normalizeClaudeModels([{ value: 'claude-opus-5' }, { value: 'sonnet' }, { value: 'claude-next-7[1m]' }]), ['claude-opus-5', 'claude-next-7']);
  assert.deepEqual(normalizeClaudeModels([]), []);
});

test('the API list and the CLI list become one, each id once, strongest first', () => {
  const api = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-haiku-4-5-20251001'];
  const cli = ['claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5'];
  assert.deepEqual(mergeClaudeModels(api, cli), ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
  assert.deepEqual(mergeClaudeModels([], cli), ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5']);
  assert.deepEqual(mergeClaudeModels(), []);
});
