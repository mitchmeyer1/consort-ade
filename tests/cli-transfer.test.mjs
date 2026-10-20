import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBundle, applyBundle } from '../src/cli/transfer.ts';

const state = () => ({
  version: 1, tasks: [], clickupKey: 'pk_1', branchPrefix: 'bot', slack: { botToken: 'xoxb-1', userId: 'U1' }, setupCompletedAt: 1,
  accounts: [
    { id: 'codex_1', name: 'work', provider: 'codex', auth: 'login', configDir: '/logins/codex_1', createdAt: 1 },
    { id: 'claude_1', name: 'mac', provider: 'claude', auth: 'login', configDir: '/logins/claude_1', createdAt: 1 },
    { id: 'claude_2', name: 'billing', provider: 'claude', auth: 'key', apiKey: 'sk-ant-1', createdAt: 1 },
  ],
  jobs: [{ id: 'job_1', name: 'roster', source: 'clickup', repo: '/home/a/roster', base: 'main', scope: { kind: 'space', id: '9' }, filters: {}, everyMinutes: 1, maxParallel: 2, statuses: {}, enabled: true, createdAt: 1, lastScanAt: 5 }],
});

test('export carries tokens, keys, the login files that exist, and each scanner with its remote; never the scan clock', async () => {
  const b = await buildBundle(state(), {
    readFile: (p) => (p === '/logins/codex_1/auth.json' ? '{"t":1}' : undefined), // the Claude login sits in the macOS keychain, so no file
    remoteOf: async () => 'git@github.com:you/roster.git',
  });
  assert.equal(b.kind, 'consort-cli-bundle');
  assert.equal(b.clickupKey, 'pk_1'); assert.equal(b.slack.userId, 'U1'); assert.equal(b.branchPrefix, 'bot');
  assert.deepEqual(b.accounts.map((a) => [a.name, a.auth, !!a.credentials, a.apiKey]), [['work', 'login', true, undefined], ['mac', 'login', false, undefined], ['billing', 'key', false, 'sk-ant-1']]);
  assert.equal(b.accounts[0].credentials.file, 'auth.json');
  assert.deepEqual(b.scanners.map((s) => [s.name, s.repoPath, s.repoRemote, 'id' in s, 'lastScanAt' in s]), [['roster', '/home/a/roster', 'git@github.com:you/roster.git', false, false]]);
});

test('import on an empty box clones the repo it lacks, writes the login file, lists the login it cannot restore, and marks setup done', async () => {
  const b = await buildBundle(state(), { readFile: (p) => (p === '/logins/codex_1/auth.json' ? '{"t":1}' : undefined), remoteOf: async () => 'git@github.com:you/roster.git' });
  const s = { version: 1, accounts: [], jobs: [], tasks: [] };
  const cloned = [], written = [];
  const r = await applyBundle(s, b, {
    repoDir: '/home/b/repos', exists: () => false,
    clone: async (remote, into) => { cloned.push([remote, into]); },
    writeCred: (p, c) => written.push([p, c]),
    create: (st, provider, name, apiKey) => { const acc = { id: `${provider}_${st.accounts.length + 1}`, name, provider, auth: apiKey ? 'key' : 'login', createdAt: 1, ...(apiKey ? { apiKey } : { configDir: `/b/logins/${provider}_${st.accounts.length + 1}` }) }; st.accounts.push(acc); return acc; },
  });
  assert.deepEqual(cloned, [['git@github.com:you/roster.git', '/home/b/repos/roster']]);
  assert.equal(s.jobs[0].repo, '/home/b/repos/roster');
  assert.deepEqual(written, [['/b/logins/codex_1/auth.json', '{"t":1}']]);
  assert.deepEqual(r.needLogin, ['claude_2']);
  assert.equal(s.clickupKey, 'pk_1'); assert.ok(s.setupCompletedAt);
  assert.deepEqual(r.added, ['ClickUp token', 'Slack', 'branch prefix', 'account work', 'account mac', 'account billing', 'scanner roster']);

  // a second import changes nothing; --replace swaps the settings only
  const create = () => { throw new Error('no'); };
  const again = await applyBundle(s, { ...b, clickupKey: 'pk_2' }, { exists: () => true, clone: async () => { throw new Error('no'); }, create });
  assert.deepEqual(again.added, []); assert.equal(s.clickupKey, 'pk_1'); assert.equal(s.jobs.length, 1);
  await applyBundle(s, { ...b, clickupKey: 'pk_2' }, { replace: true, exists: () => true, create });
  assert.equal(s.clickupKey, 'pk_2'); assert.equal(s.accounts.length, 3);
  await assert.rejects(applyBundle(s, { kind: 'other' }, { create }), /not a consort-cli export/);
});
