import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickReviewChat, reviewRunner } from '../src/shared/reviewRunner.ts';

const user = (text) => ({ role: 'user', blocks: [{ type: 'text', text }] });
const keys = [
  { id: 'k-default', name: 'mitch.meyer claude', provider: 'claude', phiAllowed: false, auth: 'login' },
  { id: 'k-chat', name: 'mitchell.meyer claude', provider: 'claude', phiAllowed: false, auth: 'login' },
  { id: 'k-codex', name: 'Mitch Codex', provider: 'codex', phiAllowed: true, auth: 'login' },
];
const chat = (over) => ({ worktreeId: 'wt', name: 'PR #450 wnstck', keyId: 'k-chat', model: 'claude-fable-5-1', delegateModel: 'claude-opus-5', lastChattedAt: 10, messages: [user('Run the pr-writeup skill for PR 450')], ...over });
const state = (chats, over = {}) => ({ keys, defaultKeyId: 'k-default', chats, models: { claude: ['claude-fable-5-1', 'claude-opus-5'] }, ...over });

test("the PR's own review chat wins over another review chat on the same branch", () => {
  const other = chat({ name: 'PR #449 wnstck', lastChattedAt: 99 });
  const own = chat();
  assert.equal(pickReviewChat([other, own], 'wt', 450), own);
  assert.equal(pickReviewChat([other, own], 'wt', 451), other, 'no chat for that PR: the most recent review chat on the branch');
  assert.equal(pickReviewChat([other, own], 'elsewhere', 450), undefined);
});

test('a plain chat on the branch is not a review chat', () => {
  assert.equal(pickReviewChat([chat({ messages: [user('rename this variable')] })], 'wt', 450), undefined);
});

test('side jobs run on the review chat\'s connector and delegate model, not the Settings default', () => {
  const r = reviewRunner(state([chat()]), 'wt', 450);
  assert.equal(r.from, 'chat');
  assert.equal(r.key.id, 'k-chat');
  assert.equal(r.model, 'claude-opus-5');
});

test('a chat with no delegate tier runs the job on its own model', () => {
  const r = reviewRunner(state([chat({ delegateModel: undefined, model: 'claude-sonnet-5' })]), 'wt', 450);
  assert.equal(r.model, 'claude-sonnet-5');
});

test('a branch with no review chat, or whose connector was removed, falls back to the default connector and tier', () => {
  const none = reviewRunner(state([]), 'wt', 450);
  assert.deepEqual([none.from, none.key.id, none.model], ['default', 'k-default', 'claude-opus-5']);
  const gone = reviewRunner(state([chat({ keyId: 'k-removed' })]), 'wt', 450);
  assert.deepEqual([gone.from, gone.key.id], ['default', 'k-default']);
  assert.equal(reviewRunner({ keys: [], chats: [] }, 'wt', 450), undefined);
});
