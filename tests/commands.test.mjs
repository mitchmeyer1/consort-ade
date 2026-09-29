import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandQuery, completeCommand, filterCommands, isClearCommand, NATIVE_COMMANDS } from '../src/shared/commands.ts';

const sdk = [
  { name: 'ship', description: 'The feature pipeline', argumentHint: '<id|new idea>' },
  { name: 'code-review', description: 'Review a PR' },
  { name: 'compact', description: 'the SDK also lists it' },
  { name: 'inbox', description: 'Claude session inbox' },
];

test('the popup opens on a lone /word and closes once arguments follow', () => {
  assert.equal(commandQuery('/'), '');
  assert.equal(commandQuery('/Sh'), 'sh');
  assert.equal(commandQuery('/ship '), undefined);
  assert.equal(commandQuery('/ship new idea'), undefined);
  assert.equal(commandQuery('hello /ship'), undefined);
  assert.equal(commandQuery(''), undefined);
});

test('filtering puts prefix matches first, then names containing the query, with Consort commands in the pool once', () => {
  assert.deepEqual(filterCommands(sdk, '').map((c) => c.name), ['clear', 'code-review', 'compact', 'inbox', 'ship']);
  assert.deepEqual(filterCommands(sdk, 'c').map((c) => c.name), ['clear', 'code-review', 'compact']);
  assert.deepEqual(filterCommands(sdk, 'in').map((c) => c.name), ['inbox']);
  assert.deepEqual(filterCommands(sdk, 'p').map((c) => c.name), ['compact', 'ship']);
  assert.deepEqual(filterCommands(sdk, 'zzz'), []);
  // the native description wins over the SDK's when both list a name
  assert.equal(filterCommands(sdk, 'compact')[0].native, true);
  assert.equal(NATIVE_COMMANDS.map((c) => c.name).join(','), 'clear,compact');
});

test('completing an entry leaves the cursor after the command, ready for arguments', () => {
  assert.equal(completeCommand(sdk[0]), '/ship ');
  assert.equal(isClearCommand(' /clear '), true);
  assert.equal(isClearCommand('/clear now'), false);
});
