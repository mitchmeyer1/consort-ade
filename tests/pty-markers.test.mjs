import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripMarkers, commandOutcome, cleanCommand, formatDuration, MIN_NOTIFY_MS, MAX_MARKER } from '../src/main/ptyMarkers.ts';

const START = (cmd) => `\x1b]7777;start${cmd === undefined ? '' : ';' + cmd}\x07`;
const EXIT = (code) => `\x1b]7777;exit;${code}\x07`;

test('markers are stripped from the stream and reported with the command text', () => {
  const r = stripMarkers('', `${START('pnpm test --watch')}running…\r\n${EXIT(0)}$ `);
  assert.equal(r.out, 'running…\r\n$ ');
  assert.equal(r.tail, '');
  assert.deepEqual(r.events, [{ type: 'start', command: 'pnpm test --watch' }, { type: 'exit', code: 0 }]);
});

test('an old-style start marker without a command still parses', () => {
  const r = stripMarkers('', START());
  assert.deepEqual(r.events, [{ type: 'start' }]);
  assert.equal(r.out, '');
});

test('a marker split across chunks is held back, even with a long command inside it', () => {
  const cmd = 'x'.repeat(190);
  const whole = START(cmd);
  const a = stripMarkers('', 'before ' + whole.slice(0, 60));
  assert.equal(a.out, 'before ');
  assert.equal(a.tail, whole.slice(0, 60), 'the partial marker waits for the rest');
  assert.deepEqual(a.events, []);
  const b = stripMarkers(a.tail, whole.slice(60) + 'after');
  assert.equal(b.out, 'after');
  assert.deepEqual(b.events, [{ type: 'start', command: cleanCommand(cmd) }], 'the reassembled command is the same cleaned text a whole chunk gives');
  assert.ok(whole.length < MAX_MARKER, 'a full marker fits inside the hold-back limit');
});

test('ordinary escape sequences pass through untouched, and a lone trailing ESC is held', () => {
  const colour = '\x1b[32mgreen\x1b[0m';
  assert.equal(stripMarkers('', colour).out, colour);
  const title = '\x1b]0;window title\x07text';
  assert.equal(stripMarkers('', title).out, title, 'other OSC sequences are not ours');
  const r = stripMarkers('', 'abc\x1b');
  assert.equal(r.out, 'abc');
  assert.equal(r.tail, '\x1b');
  assert.equal(stripMarkers(r.tail, '[1mbold').out, '\x1b[1mbold');
});

test('outcome: quick commands leave no trace, long ones mark done and notify, failures stay red', () => {
  assert.deepEqual(commandOutcome(0, 200), { failed: false, done: false, notify: false });
  assert.deepEqual(commandOutcome(0, MIN_NOTIFY_MS), { failed: false, done: true, notify: true });
  assert.deepEqual(commandOutcome(1, 5000), { failed: true, done: false, notify: true });
  assert.deepEqual(commandOutcome(1, 100), { failed: true, done: false, notify: false });
  assert.deepEqual(commandOutcome(130, 60_000), { failed: false, done: false, notify: false }, 'ctrl-c is the user, not news');
  assert.deepEqual(commandOutcome(0, undefined), { failed: false, done: false, notify: false }, 'an exit without a matching start is ignored');
});

test('command text is flattened and truncated for a notification', () => {
  assert.equal(cleanCommand('  pnpm   test\n  --watch '), 'pnpm test --watch');
  assert.equal(cleanCommand('a\x07b\x1bc'), 'a b c');
  const long = cleanCommand('y'.repeat(300));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('…'));
});

test('durations read naturally', () => {
  assert.equal(formatDuration(1500), '2s');
  assert.equal(formatDuration(65_000), '1m 05s');
  assert.equal(formatDuration(3_720_000), '1h 02m');
});
