import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Notifier } from '../src/shared/notices.ts';
import { ToastStore, TOAST_TTL } from '../src/shared/toasts.ts';

const harness = (active) => {
  const toasted = [], system = [];
  const notifier = new Notifier(() => active.value, (n) => toasted.push(n), (n) => system.push(n));
  return { notifier, toasted, system };
};

test('a notice toasts while Consort is the active window and goes to the system otherwise', () => {
  const active = { value: true };
  const h = harness(active);
  const notice = { title: 'Chat complete', body: 'PR review · ready to review', open: { chat: 'c1' }, kind: 'success' };
  h.notifier.show(notice);
  assert.deepEqual(h.toasted, [notice]);
  assert.deepEqual(h.system, []);
  active.value = false;
  h.notifier.show(notice);
  assert.deepEqual(h.system, [notice]);
  assert.equal(h.toasted.length, 1);
  assert.equal(h.notifier.inApp(), false);
});

test('an in-app notice becomes a clickable toast that remembers what to open', () => {
  const store = new ToastStore(() => {});
  const id = store.notify('info', 'Permission needed: Bash', 'PR review · click to review it in chat', { chat: 'c1' });
  assert.deepEqual(store.snapshot(), [{ id, kind: 'info', text: 'Permission needed: Bash', detail: 'PR review · click to review it in chat', open: { chat: 'c1' } }]);
  assert.ok(TOAST_TTL.info > TOAST_TTL.success, 'an informational notice lingers longer than a quick success');
});
