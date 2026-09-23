import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickActionParameters, resolveQuickAction } from '../src/shared/quickActions.ts';

test('quick-action placeholders are ordered, unique, and safe shell arguments', () => {
  const command = 'git checkout {{branch}} && echo {{message}} && git show {{branch}}';
  assert.deepEqual(quickActionParameters(command), ['branch', 'message']);
  assert.equal(resolveQuickAction(command, { branch: "feature/o'neil", message: 'hello world' }), "git checkout 'feature/o'\"'\"'neil' && echo 'hello world' && git show 'feature/o'\"'\"'neil'");
});

test('unrecognised braces are left unchanged', () => {
  assert.deepEqual(quickActionParameters('echo {{ not a parameter }} ${HOME}'), []);
  assert.equal(resolveQuickAction('echo {{ not a parameter }}', {}), 'echo {{ not a parameter }}');
});
