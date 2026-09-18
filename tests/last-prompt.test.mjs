import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastPrompt, RECALL_CHARS } from '../src/shared/lastPrompt.ts';

const say = (role, text) => ({ role, blocks: [{ type: 'text', text }] });

test('shows the most recent prompt, not the first or the reply', () => {
  const chat = { messages: [say('user', 'Add docker cleanup'), say('assistant', 'Done'), say('user', 'Now fix auto-approve'), say('assistant', 'Fixed')] };
  assert.equal(lastPrompt(chat), 'Now fix auto-approve');
});

test('clips to 128 characters with an ellipsis', () => {
  const long = 'x'.repeat(400);
  const clipped = lastPrompt({ messages: [say('user', long)] });
  assert.equal(clipped.length, RECALL_CHARS);
  assert.equal(clipped, 'x'.repeat(RECALL_CHARS - 1) + '…');
  const exact = 'y'.repeat(RECALL_CHARS);
  assert.equal(lastPrompt({ messages: [say('user', exact)] }), exact);
});

test('collapses newlines and drops the composer attachment lines', () => {
  const chat = { messages: [say('user', 'Match this screenshot\n\n  in the top bar\n\n\u{1F4CE} Screenshot 2026-09-17.png\n\u{1F4CE} notes.txt')] };
  assert.equal(lastPrompt(chat), 'Match this screenshot in the top bar');
});

test('skips non-text blocks and empty prompts, and is blank before the first prompt', () => {
  assert.equal(lastPrompt({ messages: [] }), '');
  assert.equal(lastPrompt({ messages: [say('assistant', 'Ready when you are')] }), '');
  const chat = { messages: [say('user', 'Real question'), { role: 'user', blocks: [{ type: 'text', text: '   ' }, { type: 'tool', id: 't', name: 'Bash', input: '' }] }] };
  assert.equal(lastPrompt(chat), 'Real question');
});

test('system notices never stand in for a prompt', () => {
  const chat = { messages: [say('user', 'Run the tests'), say('system', 'Docker cleanup could not finish.')] };
  assert.equal(lastPrompt(chat), 'Run the tests');
});
