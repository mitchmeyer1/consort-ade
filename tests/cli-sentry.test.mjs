import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSentry, readSentryIssues, validateSentryConfig } from '../src/cli/sentry.ts';
import { groupSentryIssues, matchingSentryTask, sentryGroupMarker } from '../src/shared/sentryScanner.ts';
import { clickupSource, sourceFor } from '../src/cli/sources.ts';
const config = { host: 'https://sentry.io', org: 'aligned', projects: ['node'], environments: ['production'], query: 'is:unresolved', token: 'sentry-secret', workspaceId: 'w', listId: 'l', folderId: 'f', tag: 'sentry', status: 'to do' };
const job = { id: 'j', name: 'Sentry', source: 'sentry', sentry: config, repo: '/repo', base: 'main', filters: {}, statuses: {}, everyMinutes: 15, maxParallel: 0, enabled: true, createdAt: 1 };
const issue = (id, extra = {}) => ({ id, shortId: `NODE-${id}`, title: 'TypeError: missing location', culprit: 'src/maps.ts in loadMap', permalink: `https://sentry.io/issues/${id}/`, project: { slug: 'node' }, status: 'unresolved', count: '12', ...extra });
function world(opts = {}) {
  const calls = [], tasks = [...(opts.tasks ?? [])], locks = new Set();
  const issues = opts.issues ?? [issue('1'), issue('2')];
  let creates = 0, searches = 0;
  const json = (data, init) => new Response(JSON.stringify(data), init);
  const fetcher = async (url, init = {}) => {
    const u = new URL(url), method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ u, method, body, auth: init.headers.Authorization });
    if (u.hostname === 'sentry.io') {
      if (opts.sentryFail) return json({}, { status: 403 });
      if (opts.sentryPages && !u.searchParams.has('cursor')) return json([issues[0]], { headers: { link: '<ignored>; rel="next"; results="true"; cursor="page2"' } });
      return json(opts.sentryPages ? issues.slice(1) : issues);
    }
    if (u.pathname === '/api/v2/list/l') return json({ id: 'l', folder: { id: opts.wrongFolder ? 'other' : 'f' }, space: { id: 'space' }, statuses: [{ status: 'to do' }] });
    if (u.pathname === '/api/v2/team/w/space') return json({ spaces: [{ id: opts.wrongWorkspace ? 'wrong' : 'space' }] });
    if (u.pathname === '/api/v2/space/space/tag') return json({ tags: [{ name: 'sentry' }] });
    if (u.pathname === '/api/v2/team/w/task') {
      searches++;
      if (opts.searchFail) return json({}, { status: 500 });
      if (opts.racingTask && searches > 1 && !tasks.length) tasks.push(opts.racingTask);
      if (opts.taskPages && u.searchParams.get('page') === '0') return json({ tasks: [{ id: 'unrelated', description: 'unrelated' }] });
      return json({ tasks, last_page: true });
    }
    if (u.pathname.startsWith('/api/v2/task/') && method === 'PUT') {
      const task = tasks.find(t => t.id === u.pathname.split('/').at(-1));
      task.markdown_description = body.markdown_content;
      return json(task);
    }
    if (u.pathname === '/api/v2/list/l/task' && method === 'POST') {
      creates++;
      const task = { id: `task-${creates}`, name: body.name, markdown_description: body.markdown_content, tags: body.tags.map(name => ({ name })), status: { status: body.status } };
      tasks.push(task);
      if (opts.createTimeout) throw new Error('connection lost after create');
      return json(task);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  };
  const deps = { fetch: fetcher, plan: opts.plan ?? (async (_, groups) => groups), reserve: async (_, key) => { if (locks.has(key)) return false; locks.add(key); return true; } };
  return { calls, tasks, locks, deps, run: extra => scanSentry(job, 'clickup-secret', { deps, ...extra }) };
}

test('duplicate Sentry issues group conservatively by project, error and location', () => {
  const groups = groupSentryIssues([issue('1'), issue('2'), issue('3', { culprit: 'different function' }), issue('4', { project: { slug: 'web' } }), issue('5', { status: 'resolved' }), issue('1')], config);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].issues.length, 2);
  assert.equal(groupSentryIssues([issue('1', { culprit: '' }), issue('2', { culprit: '' })], config).length, 2, 'unknown locations must not merge unrelated failures');
});

test('Sentry collector creates one tagged ClickUp task per group and never starts workers', async () => {
  const w = world();
  const result = await w.run();
  assert.equal(result.created, 1);
  const body = w.calls.find(c => c.method === 'POST').body;
  assert.equal(body.status, 'to do');
  assert.deepEqual(body.tags, ['sentry']);
  assert.match(body.markdown_content, /NODE-1/);
  assert.match(body.markdown_content, /NODE-2/);
  assert.ok(!body.markdown_content.includes('sentry-secret'));
  assert.equal((await w.run()).deferred, 1);
  assert.equal(w.tasks.length, 1);
  assert.throws(() => sourceFor(job, 'key'), /do not dispatch workers/);
});

test('workspace-wide search finds tickets from other agents including closed tasks and different tags/lists', async () => {
  const w = world({ taskPages: true, tasks: [{ id: 'other-agent', description: 'Already fixing https://sentry.io/issues/2/', status: { status: 'closed' }, tags: [] }] });
  assert.equal((await w.run()).existing, 1);
  const searches = w.calls.filter(c => c.u.pathname.endsWith('/team/w/task'));
  assert.ok(searches.every(c => c.u.searchParams.get('include_closed') === 'true'));
  assert.ok(searches.every(c => !c.u.searchParams.has('tags[]')));
  assert.ok(!w.calls.some(c => c.method === 'POST'));
});

test('concurrent cooperating scanners create only one task', async () => {
  const w = world();
  const results = await Promise.all([w.run(), w.run()]);
  assert.equal(results.reduce((n, r) => n + r.created, 0), 1);
  assert.equal(w.tasks.length, 1);
  assert.equal(w.locks.size, 3);
});

test('a ticket created by another agent during reservation is found by the second search', async () => {
  const w = world({ racingTask: { id: 'other', description: 'Fix NODE-1' } });
  assert.equal((await w.run()).existing, 1);
  assert.ok(!w.calls.some(c => c.method === 'POST'));
});

test('ambiguous task-creation timeout keeps reservation and avoids retry duplicates', async () => {
  const w = world({ createTimeout: true });
  await assert.rejects(w.run(), /connection lost/);
  assert.equal(w.locks.size, 3);
  assert.equal((await w.run()).deferred, 1);
  assert.equal(w.tasks.length, 1);
});

test('orphan reservation blocks creation until operator reconciliation', async () => {
  const w = world();
  w.deps.reserve = async () => false;
  const r = await w.run();
  assert.equal(r.reserved, 1);
  assert.equal(r.created, 0);
});

test('dry-run scan performs no reservations, tag writes, or task writes', async () => {
  const w = world();
  const r = await w.run({ dryRun: true });
  assert.equal(r.preview, 1);
  assert.equal(w.locks.size, 0);
  assert.ok(w.calls.every(c => c.method === 'GET'));
});

test('Sentry pagination uses scoped cursor requests with the correct token', async () => {
  const w = world({ sentryPages: true });
  const issues = await readSentryIssues(config, w.deps.fetch);
  assert.equal(issues.length, 2);
  const requests = w.calls.filter(c => c.u.hostname === 'sentry.io');
  assert.equal(requests[1].u.searchParams.get('cursor'), 'page2');
  assert.equal(requests[1].u.searchParams.get('environment'), 'production');
  assert.equal(requests[1].u.searchParams.get('project'), 'node');
  assert.equal(requests[1].auth, 'Bearer sentry-secret');
});

for (const option of ['sentryFail', 'searchFail', 'wrongFolder', 'wrongWorkspace']) test(`${option} stops ticket creation`, async () => {
  const w = world({ [option]: true });
  await assert.rejects(w.run());
  assert.ok(!w.calls.some(c => c.method === 'POST'));
});

test('existing group markers match even when a new duplicate issue ID appears', () => {
  const before = groupSentryIssues([issue('1')], config)[0];
  const after = groupSentryIssues([issue('9')], config)[0];
  assert.equal(before.key, after.key);
  assert.ok(matchingSentryTask({ description: sentryGroupMarker(before.key) }, after));
});

test('generated tickets are picked up later by an independently configured ClickUp scanner', async t => {
  const w = world();
  await w.run();
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ tasks: w.tasks, last_page: true })));
  const worker = clickupSource('key', { ...job, source: 'clickup', listId: 'l', filters: { tags: ['sentry'] } });
  const tasks = await worker.scan();
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].tags, ['sentry']);
  assert.equal(tasks[0].sentryScannerId, 'j');
});

test('invalid or unsafe configuration cannot send a token', () => {
  assert.throws(() => validateSentryConfig({ ...config, host: 'http://sentry.io' }));
  assert.throws(() => validateSentryConfig({ ...config, host: 'https://secret@example.com' }));
  assert.throws(() => validateSentryConfig({ ...config, projects: [] }));
});

test('atomic GitHub reference reservations admit one producer and retain the reference', async () => {
  const { reserveSentryGroup } = await import('../src/cli/sentry.ts');
  const refs = new Map(), calls = [];
  const gh = async args => {
    calls.push(args);
    if (args[0] === 'repo') return 'org/repo';
    if (args.includes('ref=refs/heads/consort-sentry/' + 'a'.repeat(64))) {
      const ref = 'refs/heads/consort-sentry/' + 'a'.repeat(64);
      if (refs.has(ref)) throw new Error('Reference already exists');
      refs.set(ref, 'base-sha');
      return JSON.stringify({ ref });
    }
    if (args[1] === 'repos/org/repo/git/ref/heads/main') return JSON.stringify({ object: { sha: 'base-sha' } });
    if (args[1]?.includes('git/ref/heads/consort-sentry/')) return JSON.stringify({ ref: 'refs/heads/consort-sentry/' + 'a'.repeat(64) });
    throw new Error('unexpected gh');
  };
  const results = await Promise.all([reserveSentryGroup(job, 'a'.repeat(64), gh), reserveSentryGroup(job, 'a'.repeat(64), gh)]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(refs.size, 1);
  assert.ok(!calls.some(c => c.includes('DELETE')));
});

test('empty Sentry scan checks capacity but creates no reservations', async () => {
  const w = world({ issues: [] });
  const result = await w.run();
  assert.equal(result.groups, 0);
  assert.ok(w.calls.some(c => c.u.pathname.endsWith('/team/w/task')));
  assert.equal(w.locks.size, 0);
});

test('setup explicitly chooses a child list, tag and initial status without creating tasks', async () => {
  const { configureSentryScanner } = await import('../src/cli/sentrySetup.ts');
  const answers = new Map([
    ['Name this Sentry scanner', 'Sentry intake'], ['Sentry HTTPS host', 'https://sentry.io'], ['Sentry organization slug', 'aligned'],
    ['Sentry project slugs (comma-separated)', 'node,web'], ['Environments (comma-separated; empty for all)', 'production'], ['Sentry issue query', 'is:unresolved'],
    ['Sentry auth token (event:read for organization issue access; never a DSN)', 'secret'], ['ClickUp workspace ID (deduplication searches this entire workspace)', 'w'],
    ['Destination ClickUp list or folder URL/id (use folder:<id> for a bare folder ID)', 'folder:1234567'], ['Which list inside that folder receives the Sentry tickets?', '20'],
    ['Tag to put on each created ticket (align with a ClickUp worker scanner)', 'ai-handle'], ['Initial ClickUp task status', 'ready'], ['Scan Sentry every N minutes', '15'], ['How many Sentry tickets may be worked on at once?', '1'],
  ]);
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    const data = String(url).includes('sentry.io') ? [] : String(url).includes('/team/w/space') ? { spaces: [{ id: 's' }] } : String(url).endsWith('/team') ? { teams: [{ id: 'w', name: 'Workspace' }] } : String(url).includes('/folder/') ? { lists: [{ id: '10', name: 'Other' }, { id: '20', name: 'Sentry Inbox' }] } : { name: 'Sentry Inbox', space: { id: 's' }, statuses: [{ status: 'ready' }] };
    return new Response(JSON.stringify(data));
  };
  const result = await configureSentryScanner(async (q, opts) => { assert.ok(answers.has(q), q); if (q.includes('auth token')) assert.equal(opts.secret, true); return answers.get(q); }, 'clickup-key', { repo: '/repo', base: 'main' }, fetcher);
  assert.equal(result.job.source, 'sentry');
  assert.equal(result.job.sentry.listId, '20');
  assert.equal(result.job.sentry.folderId, '1234567');
  assert.equal(result.job.sentry.tag, 'ai-handle');
  assert.equal(result.job.sentry.status, 'ready');
  assert.equal(result.job.maxParallel, 1);
  assert.equal(result.worker.maxOpenTasks, 1);
  assert.ok(calls.every(c => c.method === 'GET'));
  const defaults = new Map();
  const reused = await configureSentryScanner(async (q, opts) => {
    assert.ok(!q.includes('auth token') && !q.includes('API token'), 'saved credentials must not be requested again');
    defaults.set(q, opts?.default);
    return answers.get(q);
  }, 'clickup-key', { repo: '/repo', base: 'main' }, fetcher, [result.job]);
  assert.equal(reused.job.sentry.token, 'secret');
  assert.equal(defaults.get('Sentry organization slug'), 'aligned');
  assert.equal(defaults.get('Destination ClickUp list or folder URL/id (use folder:<id> for a bare folder ID)'), 'folder:1234567');
  assert.equal(defaults.get('Tag to put on each created ticket (align with a ClickUp worker scanner)'), 'ai-handle');
  await assert.rejects(configureSentryScanner(async q => q === 'How many Sentry tickets may be worked on at once?' ? '0' : answers.get(q), 'clickup-key', { repo: '/repo', base: 'main' }, fetcher, [result.job]), /positive whole number/);
});

test('the entire paginated scan is bundled before creating a ticket for differently named reports',async()=>{
  const {applySentryBundlePlan}=await import('../src/shared/sentryScanner.ts');
  const w=world({sentryPages:true,issues:[issue('1'),issue('2',{title:'Request failed',project:{slug:'web'},culprit:'client/map.ts'})],plan:async(_,groups)=>{
    assert.equal(groups.length,2);
    assert.equal(w.calls.filter(c=>c.u.hostname==='sentry.io').length,2);
    assert.equal(w.calls.filter(c=>c.method==='POST').length,0);
    return applySentryBundlePlan(groups,JSON.stringify({bundles:[{groupKeys:groups.map(g=>g.key),title:'Map request fails',reason:'The client map request calls the failing map handler.'}]}));
  }});
  const result=await w.run();assert.equal(result.groups,1);assert.equal(result.created,1);
  assert.match(w.tasks[0].markdown_description,/NODE-1/);assert.match(w.tasks[0].markdown_description,/NODE-2/);
  assert.match(w.tasks[0].markdown_description,/Why these reports belong together/);
});

test('invalid or incomplete planning creates no ticket or reservation',async()=>{
  const {applySentryBundlePlan}=await import('../src/shared/sentryScanner.ts');
  const w=world({plan:async(_,groups)=>applySentryBundlePlan(groups,'{"bundles":[]}')});
  await assert.rejects(w.run(),/omitted reports/);
  assert.equal(w.locks.size,0);assert.ok(!w.calls.some(c=>c.method==='POST'));
  const groups=groupSentryIssues([issue('1'),issue('2',{title:'other'})],config);
  const bundle={groupKeys:[groups[0].key],title:'A',reason:'proof'};
  assert.throws(()=>applySentryBundlePlan(groups,JSON.stringify({bundles:[bundle,bundle]})),/duplicated/);
});

test('new related reports attach to an existing task without spawning a duplicate bundle',async()=>{
  const w=world({tasks:[{id:'already-working',description:'Investigating https://sentry.io/issues/1/'}]});
  const result=await w.run();assert.equal(result.existing,1);assert.equal(result.created,0);
  assert.equal(w.calls.filter(c=>c.method==='PUT').length,1);
  assert.match(w.tasks[0].markdown_description,/NODE-2/);
  assert.equal(w.locks.size,0);
});

test('a scan with twenty independent bundles creates only the default one ticket',async()=>{
  const w=world({issues:Array.from({length:20},(_,i)=>issue(String(i+1),{title:`Bug ${i+1}`,culprit:`file-${i}.ts`}))});
  const result=await w.run();assert.equal(result.groups,20);assert.equal(result.created,1);assert.equal(result.deferred,19);assert.equal(w.tasks.length,1);
  assert.match(w.tasks[0].markdown_description,/\[consort-sentry-scanner:j\]/);
  w.calls.length=0;
  const full=await w.run();assert.equal(full.created,0);assert.equal(full.deferred,1);
  assert.ok(!w.calls.some(c=>c.u.hostname==='sentry.io'),'full capacity must not scan or invoke the AI planner');
});
test('a configured limit of two admits only two bundles and completes one before admitting another',async()=>{
  const w=world({issues:[issue('1'),issue('2',{title:'second'}),issue('3',{title:'third'})]});
  const bounded={...job,maxParallel:2};
  const result=await scanSentry(bounded,'clickup-secret',{deps:w.deps});
  assert.equal(result.created,2);assert.equal(result.deferred,1);
  const next=await scanSentry(bounded,'clickup-secret',{deps:w.deps,workers:[{ticket:{id:w.tasks[0].id},status:'ready'}]});
  assert.equal(next.created,1);assert.equal(w.tasks.length,3);
});

test('legacy queued Sentry tickets are adopted by the bounded linked worker',async()=>{
  const w=world({tasks:[{id:'old',list:{id:'l'},markdown_description:'[consort-sentry-group:old]',status:{type:'open'}}]});
  const result=await w.run();assert.equal(result.created,0);
  assert.match(w.tasks[0].markdown_description,/consort-sentry-scanner:j/);
  assert.ok(!w.calls.some(c=>c.u.hostname==='sentry.io'));
});
