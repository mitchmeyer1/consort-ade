import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as sharedShip from '../src/shared/ship.ts';

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('../src/main/ship.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled)((n) => n === '../shared/ship.ts' ? sharedShip : require(n), mod, mod.exports);
const { writeTicketFile, fetchTicket } = mod.exports;
const ticket = { source: 'clickup', id: 't1', url: 'https://app.clickup.com/t/t1', title: 'Do the thing' };

test('a fetched ticket is written to .consort/ship/TICKET.md; a failed fetch keeps the last good file and still hands back its text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ship-ticket-'));
  assert.equal(writeTicketFile(dir, ticket, undefined), undefined, 'nothing fetched, nothing on disk');
  assert.equal(existsSync(join(dir, '.consort/ship/TICKET.md')), false);
  assert.equal(writeTicketFile(dir, ticket, { body: 'first version', status: 'open' }, 5), 'first version');
  const written = readFileSync(join(dir, '.consort/ship/TICKET.md'), 'utf8');
  assert.match(written, /# Do the thing[\s\S]*Status in the tracker: open[\s\S]*first version/);
  assert.match(writeTicketFile(dir, ticket, undefined), /first version/, 'the stale file is better than none');
  assert.equal(readFileSync(join(dir, '.consort/ship/TICKET.md'), 'utf8'), written);
});

test('a ClickUp ticket without a key, or a tracker error, reads as nothing rather than throwing', async () => {
  assert.equal(await fetchTicket(ticket, { repoPath: '/nonexistent' }), undefined);
  assert.equal(await fetchTicket({ ...ticket, source: 'github', id: '1' }, { repoPath: '/nonexistent-repo-for-gh' }), undefined);
});
