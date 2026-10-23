import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftBody, draftTitle, ensureDraftPr } from '../src/cli/draftPr.ts';
import { phiSettings } from '../src/shared/phi.ts';
import * as pii from './helpers/fake-pii.mjs';

const ticket = { id: '42', title: 'Add CSV export', url: 'https://github.com/a/b/issues/42', source: 'github' };
const fake = (answers) => { const calls = []; return { calls, run: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); const hit = answers.find(([re]) => re.test([cmd, ...args].join(' '))); if (hit?.[1] instanceof Error) throw hit[1]; return hit?.[1] ?? ''; } }; };

test('the draft says it is in progress and links the ticket, with progress and the ticket text', () => {
  assert.equal(draftTitle(ticket), '[WIP] Add CSV export');
  const body = draftBody(ticket, 'Implementing (Build 3/8)', 'Users need CSV.');
  assert.match(body, /Not ready for review/);
  assert.match(body, /\*\*Ticket:\*\* https:\/\/github.com\/a\/b\/issues\/42 \(Closes #42\)/);
  assert.match(body, /\*\*Progress:\*\* Implementing \(Build 3\/8\)/);
  assert.match(body, /## Ticket\nUsers need CSV\./);
});

test('a branch without commits gets an empty start commit, is pushed, and opens as a draft', async () => {
  const f = fake([[/^gh pr list/, '[]'], [/rev-list/, '0\n'], [/^gh pr create/, 'Creating pull request\nhttps://github.com/a/b/pull/9\n']]);
  const r = await ensureDraftPr({ cwd: '/wt', base: 'development', branch: 'mm/csv', title: '[WIP] Add CSV export', body: 'b' }, f.run);
  assert.deepEqual(r, { url: 'https://github.com/a/b/pull/9', created: true });
  assert.deepEqual(f.calls.map(c => c.split(' ').slice(0, 3).join(' ')), ['gh pr list', 'git rev-list --count', 'git commit --allow-empty', 'git push --no-verify', 'gh pr create']);
  assert.ok(f.calls[4].includes('--draft --base development --head mm/csv'));
});

test('an open PR for the branch is reused; a refusal is reported, not thrown', async () => {
  const reuse = fake([[/^gh pr list/, '[{"url":"https://github.com/a/b/pull/3"}]']]);
  assert.deepEqual(await ensureDraftPr({ cwd: '/wt', base: 'main', branch: 'x', title: 't', body: 'b' }, reuse.run), { url: 'https://github.com/a/b/pull/3' });
  assert.equal(reuse.calls.length, 1);
  const refused = fake([[/^gh pr list/, '[]'], [/rev-list/, '2'], [/^gh pr create/, Object.assign(new Error('fail'), { stderr: 'GraphQL: draft PRs are not supported\n' })]]);
  assert.deepEqual(await ensureDraftPr({ cwd: '/wt', base: 'main', branch: 'x', title: 't', body: 'b' }, refused.run), { error: 'GraphQL: draft PRs are not supported' });
  assert.ok(!refused.calls.some(c => c.includes('--allow-empty')), 'no start commit when the branch has work');
});

test('under the PHI/PII guard a ticket carrying an identifier stays out of the draft, and a withheld push opens nothing', async () => {
  const gate = { phi: phiSettings({ phi: { guard: true } }), record() {} };
  const ssn = pii.ssn();
  const body = draftBody(ticket, 'Spec\'d', `Member ${ssn} cannot export`, gate);
  assert.match(body, /## Ticket\n\(description withheld by the PII gate: ssn ×1; read it on the ticket\)/);
  assert.ok(!body.includes(ssn));
  assert.match(draftBody(ticket, 'Spec\'d', 'Users need CSV.', gate), /## Ticket\nUsers need CSV\./);
  const f = fake([[/^gh pr list/, '[]'], [/rev-list/, '1']]);
  const r = await ensureDraftPr({ cwd: '/wt', base: 'main', branch: 'x', title: 't', body: 'b', guard: async () => 'Not pushed, by the PII gate: a.ts:1 ssn ×1.' }, f.run);
  assert.deepEqual(r, { error: 'Not pushed, by the PII gate: a.ts:1 ssn ×1.' });
  assert.ok(!f.calls.some((c) => c.startsWith('git push') || c.startsWith('gh pr create')));
});
