import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BREVITY, instructionsPrompt, withInstructions } from '../src/shared/instructions.ts';

const item = (text, enabled = true, id = text) => ({ id, text, enabled });

test('enabled instructions become one bulleted block; disabled and blank ones are left out', () => {
  const block = instructionsPrompt([item(BREVITY), item('  Always answer in TypeScript  '), item('Ignored', false), item('   ')]);
  assert.match(block, /^The user's standing instructions/);
  assert.deepEqual(block.split('\n').slice(1), [`- ${BREVITY}`, '- Always answer in TypeScript']);
});

test('with nothing switched on the prompt is untouched', () => {
  assert.equal(instructionsPrompt(undefined), '');
  assert.equal(instructionsPrompt([]), '');
  assert.equal(instructionsPrompt([item('off', false)]), '');
  assert.equal(withInstructions('base prompt', []), 'base prompt');
});

test('the block is appended after the base prompt, separated by a blank line', () => {
  const out = withInstructions('base prompt', [item('Be brief')]);
  assert.ok(out.startsWith('base prompt\n\nThe user'));
  assert.ok(out.endsWith('- Be brief'));
});
