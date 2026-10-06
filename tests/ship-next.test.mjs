import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillNextCommand, parseNextCommands } from '../src/shared/shipNext.ts';

test('the last footer yields one chip per /ship command, remarks dropped', () => {
  const text = `Built.\n\nStage: Implementing · Ticket: 17thtp0hyfq · Next: /ship 17thtp0hyfq (the test session, fresh chat)\n`;
  assert.deepEqual(parseNextCommands(text), [{ command: '/ship 17thtp0hyfq', label: 'Next step', needsFeedback: false }]);
});

test('several commands joined by "or", in backticks, become separate chips; a feedback placeholder is flagged', () => {
  const text = 'earlier footer\nStage: Grilling · Ticket: local:x · Next: /ship x\n\nDone.\n\n`Stage: Ready to Test · Ticket: 17thtp0hyfq · Next: /ship 17thtp0hyfq approve or /ship 17thtp0hyfq "<feedback>" (back to Revising)`';
  assert.deepEqual(parseNextCommands(text), [
    { command: '/ship 17thtp0hyfq approve', label: 'Approve', needsFeedback: false },
    { command: '/ship 17thtp0hyfq "<feedback>"', label: 'Give feedback…', needsFeedback: true },
  ]);
});

test('no footer, or a footer whose next step is not /ship, gives no chips', () => {
  assert.deepEqual(parseNextCommands('Stage: — · Ticket: — · Next: run the tests yourself'), []);
  assert.deepEqual(parseNextCommands('nothing here'), []);
});

test('feedback text fills the placeholder, quoted and escaped', () => {
  assert.equal(fillNextCommand('/ship 17thtp0hyfq "<feedback>"', ' the chips say "clear" twice '), '/ship 17thtp0hyfq "the chips say \\"clear\\" twice"');
});
