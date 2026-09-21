import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETUP_TERM, isSetupTerm, setupDoneNotice, setupStartNotice } from '../src/shared/worktreeSetup.ts';
import { commandOutcome, MIN_NOTIFY_MS } from '../src/main/ptyMarkers.ts';

test('only the worktree setup terminal is treated as setup', () => {
  assert.equal(isSetupTerm(SETUP_TERM), true);
  assert.equal(isSetupTerm('t1'), false);
  assert.equal(isSetupTerm('composer-chat-1'), false);
  assert.equal(isSetupTerm('auth'), false);
});

test('a setup run that nobody started announces itself and opens its own terminal', () => {
  const n = setupStartNotice('Retell Clinic Additions', 'pnpm install --frozen-lockfile --prefer-offline', 'w1');
  assert.equal(n.title, 'Setting up Retell Clinic Additions');
  assert.match(n.body, /pnpm install --frozen-lockfile --prefer-offline/);
  assert.equal(n.kind, 'info');
  assert.deepEqual(n.open, { scope: 'w1' });
});

test('a clean setup reads as ready, a broken one names the exit code', () => {
  const ok = setupDoneNotice('Retell Clinic Additions', 0, '1m 20s', 'w1');
  assert.equal(ok.title, 'Retell Clinic Additions is ready');
  assert.match(ok.body, /1m 20s/);
  assert.equal(ok.kind, 'success');
  assert.deepEqual(ok.open, { scope: 'w1' });

  const bad = setupDoneNotice('Retell Clinic Additions', 1, '4s', 'w1');
  assert.equal(bad.title, 'Setup failed in Retell Clinic Additions');
  assert.match(bad.body, /exit 1/);
  assert.match(bad.body, /open the terminal/);
  assert.equal(bad.kind, 'error');
});

test('a finished setup leaves no dot to come back to, however long it took', () => {
  // the amber "done" dot means "come and look"; there is nothing to look at in an install
  assert.deepEqual(commandOutcome(0, 90_000, true), { failed: false, done: false, notify: true });
  assert.deepEqual(commandOutcome(0, MIN_NOTIFY_MS, true), { failed: false, done: false, notify: true });
  // ...and it reports even when it finishes faster than a typed command would be worth mentioning,
  // because its start was announced and that toast needs an ending
  assert.deepEqual(commandOutcome(0, 200, true), { failed: false, done: false, notify: true });
  // the same command typed by hand keeps the old behaviour
  assert.deepEqual(commandOutcome(0, 90_000, false), { failed: false, done: true, notify: true });
  assert.deepEqual(commandOutcome(0, 200, false), { failed: false, done: false, notify: false });
});

test('a failed setup still leaves its red dot, because that one does need reading', () => {
  assert.deepEqual(commandOutcome(1, 4000, true), { failed: true, done: false, notify: true });
  assert.deepEqual(commandOutcome(127, 50, true), { failed: true, done: false, notify: true });
});

test('interrupting setup is the user talking, and the first prompt is not a command at all', () => {
  assert.deepEqual(commandOutcome(130, 60_000, true), { failed: false, done: false, notify: false }, 'ctrl-c is not news');
  // zsh fires precmd on the shell's very first prompt: an exit with no start before it
  assert.deepEqual(commandOutcome(0, undefined, true), { failed: false, done: false, notify: false }, 'the shell opening is not a finished install');
});
