import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prChatName } from '../src/shared/prChat.ts';

test('a review chat is named for the PR and its author', () => {
  assert.equal(prChatName({ number: 402, author: 'mitchmeyer' }, 'unused'), 'PR #402 mitchmeyer');
});

test('an unknown author leaves just the PR', () => {
  assert.equal(prChatName({ number: 400, author: '' }, 'unused'), 'PR #400');
  assert.equal(prChatName({ number: 400, author: '   ' }, 'unused'), 'PR #400');
  assert.equal(prChatName({ number: 400 }, 'unused'), 'PR #400');
});

test('a branch with no pull request keeps the fallback name', () => {
  assert.equal(prChatName(undefined, 'PR write-up · Member Panel'), 'PR write-up · Member Panel');
});
