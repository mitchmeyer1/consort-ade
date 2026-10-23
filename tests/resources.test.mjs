import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNoResource, NO_RESOURCE, resourceProblem, resourceReaderPrompt } from '../src/shared/resources.ts';

test('a resource is an absolute git checkout that is not one of the scanners\' own repositories', () => {
  const exists = (p) => p === '/notes/vault/.git' || p === '/repos/app/.git';
  assert.equal(resourceProblem('/notes/vault', ['/repos/app'], exists), undefined);
  assert.equal(resourceProblem('/notes/vault/', ['/repos/app'], exists), undefined, 'a trailing slash is the same path');
  assert.match(resourceProblem('notes/vault', [], exists), /not an absolute path/);
  assert.match(resourceProblem('/notes/empty', [], exists), /not a git checkout/);
  assert.match(resourceProblem('/repos/app', ['/repos/app/'], exists), /scanner's own repository/);
});

test('only a reply that is the marker alone means nothing bears on the ticket', () => {
  assert.ok(isNoResource(NO_RESOURCE));
  assert.ok(isNoResource('  [Resource: NONE]\n'));
  assert.ok(!isNoResource(`Relevant: one note.\n${NO_RESOURCE}`));
  assert.ok(!isNoResource(''));
});

test('the reader prompt keeps the reader read-only and offline, asks for paths and dates, and carries the ticket', () => {
  const p = resourceReaderPrompt('team-notes', 'Open an Intercom ticket from the app');
  assert.match(p, /working directory is "team-notes"/);
  assert.match(p, /Do not edit, create, move or delete anything/);
  assert.match(p, /Do not search the web or fetch URLs/);
  assert.match(p, /write no \[ask-user\] line/);
  assert.match(p, /Conflicts with the ticket/);
  assert.match(p, /its date .* and its path relative to this directory/);
  assert.ok(p.includes(NO_RESOURCE));
  assert.ok(p.endsWith('Ticket:\nOpen an Intercom ticket from the app'));
});
