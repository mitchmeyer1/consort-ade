import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWorkspace, prFooter, repoDirs, reposForPr, reposToCommit, slugify, workspaceSources, workspaceSummary } from '../src/shared/workspace.ts';

const project = (id, path, extra = {}) => ({ id, name: id, path, defaultBase: 'origin/main', ...extra });
const status = (over = {}) => ({ branch: 'mm/x', dirty: 0, ahead: 0, behind: 0, merged: false, inBase: false, base: 'origin/main', files: '', ...over });

test('names become folder slugs and repo folders are unique', () => {
  assert.equal(slugify('Billing Rework!'), 'billing-rework');
  assert.equal(slugify('   '), 'workspace');
  assert.deepEqual(repoDirs([project('a', '/w/api'), project('b', '/x/api'), project('c', '/y/web/')]), [
    { projectId: 'a', dir: 'api' }, { projectId: 'b', dir: 'api-2' }, { projectId: 'c', dir: 'web' },
  ]);
});

test('a workspace resolves its sources and skips one that was removed', () => {
  const ws = project('ws', '/lib/workspaces/billing', { kind: 'workspace', branch: 'mm/billing', repos: [{ projectId: 'a', dir: 'api' }, { projectId: 'gone', dir: 'old' }] });
  const state = { projects: [project('a', '/w/api'), ws] };
  assert.equal(isWorkspace(ws), true);
  assert.equal(isWorkspace(project('a', '/w/api')), false);
  assert.deepEqual(workspaceSources(state, ws).map((s) => [s.project.id, s.dir, s.path]), [['a', 'api', '/lib/workspaces/billing/api']]);
});

test('summary, commit and PR selections read across repos', () => {
  const st = { branch: 'mm/x', repos: [
    { projectId: 'a', name: 'api', dir: 'api', path: '/p/api', status: status({ dirty: 3, ahead: 2, pr: { number: 7, state: 'OPEN' }, ci: { state: 'fail' } }) },
    { projectId: 'b', name: 'web', dir: 'web', path: '/p/web', status: status({ ahead: 1 }) },
    { projectId: 'c', name: 'svc', dir: 'svc', path: '/p/svc', status: status({ inBase: true }) },
    { projectId: 'd', name: 'late', dir: 'late', path: '/p/late', status: null },
  ] };
  assert.deepEqual(workspaceSummary(st), { dirty: 3, ahead: 3, behind: 0, prs: 1, failing: 1 });
  assert.deepEqual(reposToCommit(st).map((r) => r.dir), ['api']);
  assert.deepEqual(reposForPr(st).map((r) => r.dir), ['web'], 'api has a PR, svc adds nothing, late is unknown');
  assert.deepEqual(workspaceSummary(null), { dirty: 0, ahead: 0, behind: 0, prs: 0, failing: 0 });
});

test('the PR footer links siblings and is omitted for a lone PR', () => {
  assert.equal(prFooter('Billing', [{ name: 'api', url: 'https://x/1' }]), '');
  const footer = prFooter('Billing', [{ name: 'api', url: 'https://x/1' }, { name: 'web', url: 'https://y/2' }]);
  assert.match(footer, /\*\*Billing\*\* workspace/);
  assert.match(footer, /- api: https:\/\/x\/1\n- web: https:\/\/y\/2/);
});
