import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReviewChat, reviewProgress } from '../src/shared/reviewProgress.ts';

const user = (text) => ({ role: 'user', blocks: [{ type: 'text', text }] });
const tool = (name, input, output, ok) => ({ type: 'tool', id: `${name}-${input}`, name, input, output, ok });
const assistant = (...blocks) => ({ role: 'assistant', blocks });
const review = (messages, running = true) => ({ messages: [user('Run the pr-writeup skill for PR 402'), ...messages], running, phase: 'executing' });
const byId = (stages) => Object.fromEntries(stages.map((s) => [s.id, s]));

test('only chats started from the review skill get a progress panel', () => {
  assert.equal(isReviewChat({ messages: [user('Run the pr-writeup skill for PR 402')] }), true);
  assert.equal(isReviewChat({ messages: [user('fix the dropdown')] }), false);
  assert.equal(reviewProgress({ messages: [user('fix the dropdown')], running: true, phase: 'executing' }), null);
});

test('a review that has only just started shows scope live and the rest waiting', () => {
  const stages = byId(reviewProgress(review([assistant(tool('Bash', 'gh pr view 402', undefined, undefined))])));
  assert.equal(stages.scope.state, 'active');
  assert.equal(stages.agents.state, 'pending');
  assert.equal(stages.publish.state, 'pending');
});

test('the fan-out counts agents, since each one owns a group of files', () => {
  const names = 'src/api/claims.ts\nsrc/api/claims.test.ts\nsrc/ui/Panel.tsx\n';
  const stages = byId(reviewProgress(review([
    assistant(tool('Bash', 'gh pr diff 402 --name-only', names, true)),
    assistant(tool('Task', 'review src/api/claims.ts', 'DEFECT ...', true), tool('Task', 'review src/ui/Panel.tsx', undefined, undefined)),
  ])));
  assert.equal(stages.agents.state, 'active');
  assert.equal(stages.agents.done, 1);
  assert.equal(stages.agents.total, 2);
  assert.equal(stages.agents.detail, '1/2 agents back');
  assert.equal(stages.scope.detail, '3 changed files');
});

test('dispatching agents settles the earlier stages', () => {
  const stages = byId(reviewProgress(review([
    assistant(tool('Bash', 'gh pr diff 402 --name-only', 'a.ts\nb.ts\n', true)),
    assistant(tool('Grep', 'router.post', 'src/api/routes.ts:14', true)),
    assistant(tool('Task', 'review a.ts', undefined, undefined)),
  ])));
  assert.equal(stages.scope.state, 'done');
  assert.equal(stages.flows.state, 'done');
  assert.equal(stages.agents.state, 'active');
});

test('when the agents are back, verification is the live stage', () => {
  const stages = byId(reviewProgress(review([
    assistant(tool('Bash', 'gh pr diff 402 --name-only', 'a.ts\n', true)),
    assistant(tool('Task', 'review a.ts', 'DEFECT a.ts:20', true)),
    assistant(tool('Read', 'a.ts:20', 'const x = 1', true)),
  ])));
  assert.equal(stages.agents.state, 'done');
  assert.equal(stages.verify.state, 'active');
  assert.equal(stages.writeup.state, 'pending');
});

test('writing the report, then publishing it, walk the last two stages', () => {
  const writing = review([
    assistant(tool('Bash', 'gh pr diff 402 --name-only', 'a.ts\n', true)),
    assistant(tool('Task', 'review a.ts', 'DEFECT', true)),
    assistant(tool('Write', '.consort/pr-writeup.html', undefined, undefined)),
  ]);
  const mid = byId(reviewProgress(writing));
  assert.equal(mid.verify.state, 'done');
  assert.equal(mid.writeup.state, 'active');
  assert.equal(mid.publish.state, 'pending');

  writing.messages.at(-1).blocks[0].ok = true;
  const written = byId(reviewProgress(writing));
  assert.equal(written.writeup.state, 'done');
  assert.equal(written.publish.state, 'active');

  writing.running = false;
  const finished = byId(reviewProgress(writing));
  assert.equal(finished.publish.state, 'done');
  assert.ok(Object.values(finished).every((s) => s.state === 'done'), 'a finished review reads as finished');
});

test('exactly one stage is live at a time', () => {
  const stages = reviewProgress(review([
    assistant(tool('Bash', 'gh pr diff 402 --name-only', 'a.ts\nb.ts\n', true)),
    assistant(tool('Task', 'review a.ts', 'DEFECT', true), tool('Task', 'review b.ts', undefined, undefined)),
    assistant(tool('Read', 'a.ts', 'x', true)),
  ]));
  assert.equal(stages.filter((s) => s.state === 'active').length, 1);
});

test('writing the shared brief counts as scope settled even before the first agent', () => {
  for (const ledger of ['.consort/pr-review/brief.md', '.consort/pr-review-coverage.md']) {
    const stages = byId(reviewProgress(review([
      assistant(tool('Bash', 'gh pr view 402', 'title', true)),
      assistant(tool('Write', ledger, undefined, true)),
    ])));
    assert.equal(stages.flows.state, 'done', ledger);
    assert.equal(stages.agents.state, 'pending', ledger);
  }
});

test('the review file counts as the report, just as the HTML document did', () => {
  for (const file of ['.consort/pr-review/pr-402.review.json', '.consort/pr-writeup.html']) {
    const stages = byId(reviewProgress(review([
      assistant(tool('Bash', 'gh pr diff 402 --name-only', 'a.ts\n', true)),
      assistant(tool('Task', 'review a.ts', 'DEFECT', true)),
      assistant(tool('Write', file, undefined, true)),
    ], false)));
    assert.equal(stages.writeup.state, 'done', file);
    assert.equal(stages.publish.state, 'done', file);
  }
});
