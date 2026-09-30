import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldLabel, groupBlocks, showToolCalls } from '../src/shared/toolFold.ts';

const tool = (id, name, ok) => ({ type: 'tool', id, name, input: '{}', ...(ok === undefined ? {} : { ok }) });
const text = (t) => ({ type: 'text', text: t });

test('consecutive tool calls fold into one segment; prose splits runs', () => {
  const blocks = [text('Looking.'), tool('1', 'Bash', true), tool('2', 'Bash', true), tool('3', 'Read', true), text('Found it.'), tool('4', 'Edit', true)];
  const segs = groupBlocks(blocks, false);
  assert.deepEqual(segs.map((s) => s.type), ['text', 'fold', 'text', 'fold']);
  assert.equal(segs[1].tools.length, 3);
  assert.equal(foldLabel(segs[1].tools), '3 tool calls · Bash ×2 Read');
  assert.equal(foldLabel(segs[3].tools), '1 tool call · Edit');
});

test('a failed call and the running call stay outside the fold', () => {
  const blocks = [tool('1', 'Bash', true), tool('2', 'Bash', false), tool('3', 'Read', true), tool('4', 'Grep')];
  assert.deepEqual(groupBlocks(blocks, true).map((s) => s.type === 'tool' ? `tool:${s.block.id}` : `${s.type}:${s.tools?.length ?? ''}`), ['fold:1', 'tool:2', 'fold:1', 'tool:4']);
  // once the turn is over an unfinished call is just cut off, and folds with the rest
  assert.deepEqual(groupBlocks(blocks, false).map((s) => s.type), ['fold', 'tool', 'fold']);
});

test('the per-chat toggle overrides the global setting, and quiet is the default', () => {
  assert.equal(showToolCalls({}, undefined), false);
  assert.equal(showToolCalls({}, true), true);
  assert.equal(showToolCalls({ showToolCalls: false }, true), false);
  assert.equal(showToolCalls({ showToolCalls: true }, false), true);
});
