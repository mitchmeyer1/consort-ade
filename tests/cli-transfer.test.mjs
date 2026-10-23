import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBundle, applyBundle } from '../src/cli/transfer.ts';

const state = () => ({
  version: 1, hostId: 'test-host', tasks: [], clickupKey: 'pk_1', branchPrefix: 'bot', slack: { botToken: 'xoxb-1', userId: 'U1' }, setupCompletedAt: 1,
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


test('Sentry producer routing and credentials survive export/import without live scan clocks', async () => {
  const s = state();
  s.jobs = [{ ...s.jobs[0], source: 'sentry', name: 'Sentry intake', scanStartedAt: 88, sentry: { host: 'https://sentry.io', org: 'org', projects: ['node'], environments: ['production'], token: 'sentry-secret', workspaceId: 'w', listId: 'l', folderId: 'f', tag: 'sentry', status: 'to do', query: 'is:unresolved' } }];
  const bundle = await buildBundle(s, { readFile: () => undefined, remoteOf: async () => 'https://github.com/org/repo.git' });
  assert.equal(bundle.scanners[0].sentry.token, 'sentry-secret');
  assert.equal(bundle.scanners[0].sentry.listId, 'l');
  assert.equal('scanStartedAt' in bundle.scanners[0], false);
  const fresh = { version: 1, tasks: [], jobs: [], accounts: [] };
  await applyBundle(fresh, { ...bundle, accounts: [] }, { exists: () => true, create() { throw new Error('not needed'); } });
  assert.equal(fresh.jobs[0].source, 'sentry');
  assert.equal(fresh.jobs[0].sentry.tag, 'sentry');
});


test('model roles and capacity settings survive export and import', async () => {
  const s = state();
  s.capacity = { maxActiveTurns: 3, maxOpenTasks: 10, maxEnvironments: 6 };
  s.accounts[0].maxActiveTurns = 1;
  Object.assign(s.jobs[0], { modelPolicy: { planning: { codex: 'gpt-6.1-sol' }, reader: { claude: 'claude-haiku-4-5-20251001' } }, parallelResearch: 2, parallelImplementation: 2, maxOpenTasks: 5, maxEnvironments: 4 });
  const b = await buildBundle(s, { readFile: () => undefined, remoteOf: async () => undefined });
  const fresh = { version: 1, tasks: [], accounts: [], jobs: [] };
  await applyBundle(fresh, b, { exists: () => true, create: (st, provider, name) => { const account = { id: name, name, provider, auth: 'key', createdAt: 1 }; st.accounts.push(account); return account; } });
  assert.deepEqual(fresh.capacity, s.capacity);
  assert.equal(fresh.accounts[0].maxActiveTurns, 1);
  assert.deepEqual(fresh.jobs[0].modelPolicy, s.jobs[0].modelPolicy);
  assert.equal(fresh.jobs[0].parallelImplementation, 2);
  assert.equal(fresh.jobs[0].maxOpenTasks, 5);
});

const createAccountStub = (st, provider, name, apiKey) => { const acc = { id: `${provider}_${st.accounts.length + 1}`, name, provider, auth: apiKey ? 'key' : 'login', createdAt: 1, ...(apiKey ? { apiKey } : { configDir: `/b/logins/${provider}_${st.accounts.length + 1}` }) }; st.accounts.push(acc); return acc; };

test('project info resources travel with their remotes; import reuses a checkout that is here, clones one that is not, and leaves out one it cannot get', async () => {
  const s = state();
  s.resources = [
    { id: 'res_1', name: 'team-notes', kind: 'markdown', path: '/home/a/notes' },
    { id: 'res_2', name: 'local-only', kind: 'markdown', path: '/home/a/scratch-notes' },
    { id: 'res_3', name: 'shared', kind: 'markdown', path: '/srv/shared-notes' },
  ];
  const remotes = { '/home/a/roster': 'git@github.com:you/roster.git', '/home/a/notes': 'git@github.com:you/team-notes.git', '/srv/shared-notes': 'git@github.com:you/shared-notes.git' };
  const b = await buildBundle(s, { readFile: () => undefined, remoteOf: async (p) => remotes[p] });
  assert.deepEqual(b.resources, [
    { name: 'team-notes', kind: 'markdown', path: '/home/a/notes', remote: 'git@github.com:you/team-notes.git' },
    { name: 'local-only', kind: 'markdown', path: '/home/a/scratch-notes', remote: undefined },
    { name: 'shared', kind: 'markdown', path: '/srv/shared-notes', remote: 'git@github.com:you/shared-notes.git' },
  ]);
  const fresh = { version: 1, accounts: [], jobs: [], tasks: [] };
  const cloned = [];
  const r = await applyBundle(fresh, b, { repoDir: '/home/b/repos', exists: (p) => p === '/srv/shared-notes/.git', clone: async (remote, into) => { cloned.push([remote, into]); }, writeCred() {}, create: createAccountStub });
  assert.deepEqual(cloned, [['git@github.com:you/roster.git', '/home/b/repos/roster'], ['git@github.com:you/team-notes.git', '/home/b/repos/team-notes']]);
  assert.deepEqual(fresh.resources.map((x) => [x.name, x.kind, x.path]), [['team-notes', 'markdown', '/home/b/repos/team-notes'], ['shared', 'markdown', '/srv/shared-notes']]);
  assert.ok(fresh.resources.every((x) => x.id && !['res_1', 'res_3'].includes(x.id)), 'fresh ids on this box');
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /^resource local-only: \/home\/a\/scratch-notes is not here and could not be cloned; imported without it/);
  assert.ok(r.added.includes('resource team-notes') && r.added.includes('resource shared'));
});

test('a resource whose clone fails is left out with a note, one already here by name is kept, and an export without resources has none', async () => {
  const s = state();
  s.resources = [{ id: 'res_1', name: 'team-notes', kind: 'markdown', path: '/home/a/notes' }, { id: 'res_2', name: 'wiki', kind: 'markdown', path: '/home/a/wiki' }];
  const b = await buildBundle(s, { readFile: () => undefined, remoteOf: async (p) => (p === '/home/a/roster' ? 'git@github.com:you/roster.git' : `git@github.com:you/${p.split('/').pop()}.git`) });
  const box = { version: 1, accounts: [], jobs: [], tasks: [], resources: [{ id: 'res_9', name: 'wiki', kind: 'markdown', path: '/srv/wiki' }] };
  const r = await applyBundle(box, b, { repoDir: '/home/b/repos', exists: () => false, clone: async (remote) => { if (remote.endsWith('notes.git')) throw new Error('auth failed'); }, writeCred() {}, create: createAccountStub });
  assert.deepEqual(box.resources.map((x) => x.name), ['wiki'], 'the clone failure is left out, the local wiki is kept');
  assert.equal(box.resources[0].path, '/srv/wiki');
  assert.ok(r.kept.includes('resource wiki'));
  assert.match(r.notes.join('\n'), /resource team-notes: .* imported without it/);
  const plain = await buildBundle(state(), { readFile: () => undefined, remoteOf: async () => 'git@github.com:you/roster.git' });
  assert.equal('resources' in plain, false);
});

test('the guard settings and the covered key reference travel; the key never does, and import says where to put it', async () => {
  const s = state();
  s.phi = { guard: true, minCell: 11 };
  s.covered = { kind: 'keychain', service: 'anthropic-phi-api-key', account: 'consort-cli' };
  const b = await buildBundle(s, { readFile: () => undefined, remoteOf: async () => 'git@github.com:you/roster.git' });
  assert.deepEqual(b.covered, s.covered);
  assert.deepEqual(b.phi, s.phi);
  const fresh = { version: 1, accounts: [], jobs: [], tasks: [] };
  const r = await applyBundle(fresh, b, { repoDir: '/home/b/repos', exists: () => true, clone: async () => {}, writeCred() {}, create: createAccountStub });
  assert.deepEqual(fresh.covered, s.covered);
  assert.equal(fresh.phi.guard, true);
  assert.ok(r.notes.some((n) => /covered key reference imported \(Keychain item anthropic-phi-api-key \(account consort-cli\)\); the key itself is not in the export/.test(n)));
  const kept = { version: 1, accounts: [], jobs: [], tasks: [], covered: { kind: 'file', path: '/srv/key' } };
  await applyBundle(kept, b, { repoDir: '/home/b/repos', exists: () => true, clone: async () => {}, writeCred() {}, create: createAccountStub });
  assert.deepEqual(kept.covered, { kind: 'file', path: '/srv/key' }, 'a reference already here is kept unless --replace');
});
