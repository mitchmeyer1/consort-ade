import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldLabel, groupBlocks, mergeAssistantRuns, showToolCalls } from '../src/shared/toolFold.ts';

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

test('a failed call stays outside the fold; the running call is counted and the line says so', () => {
  const blocks = [tool('1', 'Bash', true), tool('2', 'Bash', false), tool('3', 'Read', true), tool('4', 'Grep')];
  assert.deepEqual(groupBlocks(blocks, true).map((s) => s.type === 'tool' ? `tool:${s.block.id}` : `${s.type}:${s.tools?.length ?? ''}`), ['fold:1', 'tool:2', 'fold:2']);
  assert.equal(foldLabel(groupBlocks(blocks, true)[2].tools, true), '2 tool calls · Read Grep · running');
  // once the turn is over nothing is running
  assert.equal(foldLabel(groupBlocks(blocks, false)[2].tools, false), '2 tool calls · Read Grep');
});

test('consecutive assistant messages (one per API turn) show as one, so the fold grows as calls come in', () => {
  const msgs = [
    { id: 'u', role: 'user', blocks: [text('go')] },
    { id: 'a1', role: 'assistant', blocks: [text('Looking.'), tool('1', 'Bash', true)] },
    { id: 'a2', role: 'assistant', blocks: [tool('2', 'Bash', true)] },
    { id: 'a3', role: 'assistant', blocks: [tool('3', 'Bash')] },
    { id: 's', role: 'system', blocks: [text('note')] },
    { id: 'a4', role: 'assistant', blocks: [tool('4', 'Read', true)] },
  ];
  const shown = mergeAssistantRuns(msgs);
  assert.deepEqual(shown.map((m) => m.id), ['u', 'a1', 's', 'a4']);
  assert.equal(shown[1].blocks.length, 4);
  assert.equal(foldLabel(groupBlocks(shown[1].blocks, true)[1].tools, true), '3 tool calls · Bash ×3 · running');
  assert.equal(msgs[1].blocks.length, 2, 'the chat is not mutated');
});

test('the per-chat toggle overrides the global setting, and quiet is the default', () => {
  assert.equal(showToolCalls({}, undefined), false);
  assert.equal(showToolCalls({}, true), true);
  assert.equal(showToolCalls({ showToolCalls: false }, true), false);
  assert.equal(showToolCalls({ showToolCalls: true }, false), true);
});
