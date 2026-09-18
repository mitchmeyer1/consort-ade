import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToastStore, TOAST_TTL } from '../src/shared/toasts.ts';

// a manual clock: timers fire only when the test says so
function clock() {
  const due = [];
  return { timer: (fn, ms) => due.push({ fn, ms }), fire: () => { const all = due.splice(0); all.forEach((d) => d.fn()); return all.map((d) => d.ms); } };
}

test('start shows a loading toast that stays until it settles, then lingers and dismisses itself', () => {
  const c = clock();
  const store = new ToastStore(c.timer);
  let notified = 0;
  store.subscribe(() => notified++);
  const id = store.start('Creating worktree feat…');
  assert.deepEqual(store.snapshot(), [{ id, kind: 'loading', text: 'Creating worktree feat…' }]);
  assert.deepEqual(c.fire(), [], 'a loading toast schedules no dismissal');
  store.succeed(id, 'Worktree feat ready');
  assert.deepEqual(store.snapshot(), [{ id, kind: 'success', text: 'Worktree feat ready' }]);
  assert.deepEqual(c.fire(), [TOAST_TTL.success]);
  assert.deepEqual(store.snapshot(), []);
  assert.equal(notified, 3);
});

test('a failure carries the first line of the error and lingers longer than a success', () => {
  const c = clock();
  const store = new ToastStore(c.timer);
  const id = store.start('Deleting worktree x…');
  store.fail(id, "Couldn't delete worktree x", 'fatal: locked\nmore detail');
  assert.deepEqual(store.snapshot(), [{ id, kind: 'error', text: "Couldn't delete worktree x", detail: 'fatal: locked\nmore detail' }]);
  assert.ok(TOAST_TTL.error > TOAST_TTL.success);
  assert.deepEqual(c.fire(), [TOAST_TTL.error]);
  assert.deepEqual(store.snapshot(), []);
});

test('a stale dismissal timer does not remove a toast that has since changed', () => {
  const due = [];
  const store = new ToastStore((fn, ms) => due.push({ fn, ms }));
  const id = store.start('Deleting…');
  store.succeed(id, 'Deleted');
  store.fail(id, 'Actually failed', 'the sync afterwards broke');
  assert.deepEqual(due.map((d) => d.ms), [TOAST_TTL.success, TOAST_TTL.error]);
  due[0].fn(); // the success timer fires first
  assert.equal(store.snapshot()[0]?.kind, 'error', 'the newer error toast survives the older timer');
  due[1].fn();
  assert.deepEqual(store.snapshot(), []);
});

test('snapshots are immutable and only replaced on change, as useSyncExternalStore needs', () => {
  const c = clock();
  const store = new ToastStore(c.timer);
  const empty = store.snapshot();
  store.dismiss('nothing');
  assert.equal(store.snapshot(), empty, 'dismissing an unknown id emits nothing');
  const id = store.start('x');
  const one = store.snapshot();
  assert.notEqual(one, empty);
  store.succeed(id, 'y');
  assert.notEqual(store.snapshot(), one);
  assert.equal(one[0].kind, 'loading', 'earlier snapshots are untouched');
  store.dismiss(id);
  assert.deepEqual(store.snapshot(), []);
});

test('track narrates a promise: success text and value, or failure text with the message', async () => {
  const c = clock();
  const store = new ToastStore(c.timer);
  let release;
  const work = new Promise((res) => { release = res; });
  const tracked = store.track(work, { start: 'Creating…', done: 'Ready', fail: 'Failed' });
  assert.equal(store.snapshot()[0].kind, 'loading');
  release('wt-1');
  assert.equal(await tracked, 'wt-1');
  assert.deepEqual(store.snapshot().map((t) => [t.kind, t.text]), [['success', 'Ready']]);
  const failed = await store.track(Promise.reject(new Error('branch exists\nhint')), { start: 'Creating…', done: 'Ready', fail: 'Failed' });
  assert.equal(failed, undefined, 'track never throws; the toast carries the error');
  assert.deepEqual(store.snapshot().map((t) => [t.kind, t.text, t.detail]), [['success', 'Ready', undefined], ['error', 'Failed', 'branch exists']]);
});

test('concurrent operations stack in start order', () => {
  const store = new ToastStore(clock().timer);
  const a = store.start('a');
  const b = store.start('b');
  store.succeed(a, 'a done');
  assert.deepEqual(store.snapshot().map((t) => t.id), [a, b], 'settling keeps the slot rather than reordering');
});
