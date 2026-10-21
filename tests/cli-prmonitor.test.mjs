import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import * as headless from '../src/shared/headless.ts';
const code = ts.transpileModule(readFileSync(new URL('../src/cli/prmonitor.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

test('PR polling notices a new human reply in an existing thread and top-level review comments', async () => {
  let comment = { author: { login: 'ada' }, body: 'Please change label', url: 'url', createdAt: '2026-10-20T10:00:00Z' };
  const mocks = {
    '../shared/headless.ts': headless,
    'node:child_process': { execFile() {} },
    'node:util': { promisify: () => async (_, args) => ({ stdout: JSON.stringify(args[0] === 'pr' ? {
      state: 'OPEN', url: 'url', reviews: [{ id: 'r', author: { login: 'bob' }, body: 'Design question', state: 'CHANGES_REQUESTED', submittedAt: 'now' }], statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    } : args[0] === 'repo' ? { nameWithOwner: 'org/repo' } : { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: 'thread', isResolved: false, comments: { nodes: [{ author: { login: 'ada' }, body: 'Original', createdAt: 'old' }, comment] } }] } } } } }) }) },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(n => mocks[n] ?? require(n), mod, mod.exports);
  const before = await mod.exports.readPr('/virtual', 1);
  comment = { ...comment, body: 'Follow-up request', createdAt: '2026-10-20T11:00:00Z' };
  const after = await mod.exports.readPr('/virtual', 1);
  assert.notEqual(before.unresolved[0].id, after.unresolved[0].id);
  assert.match(after.unresolved[0].body, /GitHub thread ID: thread\nFollow-up request/);
  assert.equal(after.feedback[0].author, 'bob');
  assert.match(after.feedback[0].body, /Top-level review \(no thread\): Design question/);
  assert.equal(after.ci, 'pass');
});


test('reviewer suggestions prefer changed-file contributors and fill from GitHub contributors', async () => {
  const calls = [];
  const mocks = {
    '../shared/headless.ts': headless,
    'node:child_process': { execFile() {} },
    'node:util': { promisify: () => async (cmd, args) => {
      calls.push(args);
      const stdout = cmd === 'git' ? args[0] === 'diff' ? 'src/map.ts\n' : ' 30 Owner <1+owner@users.noreply.github.com>\n 5 Ada <2+ada@users.noreply.github.com>\n 99 Unknown <unknown@company.com>' : args[0] === 'repo' ? 'org/repo' : JSON.stringify([[{ login: 'owner', type: 'User', contributions: 200 }, { login: 'bob', type: 'User', contributions: 100 }, { login: 'bot', type: 'Bot', contributions: 500 }], [{ login: 'ada', type: 'User', contributions: 20 }, { login: 'other', type: 'User', contributions: 10 }]]);
      return { stdout };
    } },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(n => mocks[n] ?? require(n), mod, mod.exports);
  assert.deepEqual(await mod.exports.reviewerSuggestions('/repo', 'origin/main', ['OWNER']), ['ada', 'bob']);
  assert.ok(calls.some(args => args.includes('--paginate') && args.includes('--slurp')));
  assert.ok(calls.some(args => args[0] === 'shortlog' && args.includes('src/map.ts')));
});

test('batch waits three minutes and resets for additions, edits, replacement comments, or resolutions', () => {
  const comment = { id: 'thread:1', author: 'ada', body: 'Fix label' };
  const first = headless.observeReviewBatch(undefined, [comment], 1000);
  assert.equal(first.ready, false);
  assert.equal(headless.observeReviewBatch(first.batch, [comment], 180999).ready, false);
  assert.equal(headless.observeReviewBatch(first.batch, [comment], 181000).ready, true);
  for (const next of [[{ ...comment, id: 'thread:2' }], [{ ...comment, body: 'Changed request' }], [comment, { ...comment, id: 'thread:2' }]]) {
    const changed = headless.observeReviewBatch(first.batch, next, 181000);
    assert.equal(changed.ready, false);
    assert.equal(changed.batch.stableSince, 181000);
  }
  assert.deepEqual(headless.observeReviewBatch(first.batch, [], 181000), { ready: false });
  const two = [comment, { ...comment, id: 'thread:2' }];
  const batch = headless.observeReviewBatch(undefined, two, 1000).batch;
  assert.equal(headless.observeReviewBatch(batch, two.toReversed(), 181000).ready, true, 'API order does not reset the wait');
  assert.equal(headless.observeReviewBatch(batch, [comment], 181000).ready, false, 'a resolution changes the batch');
});


test('PR polling reads every thread page and detects edits without a new timestamp', async () => {
  let body = 'Original request', pages = 0;
  const mocks = {
    '../shared/headless.ts': headless,
    'node:child_process': { execFile() {} },
    'node:util': { promisify: () => async (_, args) => {
      let value;
      if (args[0] === 'pr') value = { state: 'OPEN', author: { login: 'builder' }, reviews: [], statusCheckRollup: [] };
      else if (args[0] === 'repo') value = { nameWithOwner: 'org/repo' };
      else {
        pages++;
        const second = args.includes('cursor=page2');
        value = { data: { repository: { pullRequest: { reviewThreads: {
          pageInfo: { hasNextPage: !second, endCursor: second ? null : 'page2' },
          nodes: [{ id: second ? 'thread2' : 'thread1', isResolved: false, comments: { nodes: [{ author: { login: 'ada' }, body, createdAt: 'same' }, { author: { login: 'builder' }, body: 'I will check', createdAt: 'later' }] } }],
        } } } } };
      }
      return { stdout: JSON.stringify(value) };
    } },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(n => mocks[n] ?? require(n), mod, mod.exports);
  const first = await mod.exports.readPr('/repo', 1);
  assert.equal(first.unresolved.length, 2);
  assert.equal(first.unresolved[0].author, 'ada', 'builder replies cannot hide unresolved human requests');
  body = 'Edited request';
  const next = await mod.exports.readPr('/repo', 1);
  assert.notEqual(first.unresolved[0].id, next.unresolved[0].id);
  assert.equal(pages, 4);
});

test('CI cannot pass with absent, unknown, unfinished, stale, or startup-failed checks', async () => {
  let checks = [];
  const mocks = {
    '../shared/headless.ts': headless,
    'node:child_process': { execFile() {} },
    'node:util': { promisify: () => async (_, args) => ({ stdout: JSON.stringify(args[0] === 'pr' ? { state: 'OPEN', reviews: [], statusCheckRollup: checks } : args[0] === 'repo' ? { nameWithOwner: 'org/repo' } : { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }) }) },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(n => mocks[n] ?? require(n), mod, mod.exports);
  for (const [rollup, expected] of [
    [[], 'none'], [[{ conclusion: 'SUCCESS' }], 'pass'], [[{ state: 'SUCCESS' }], 'pass'],
    [[{ status: 'IN_PROGRESS' }], 'pending'], [[{ status: 'COMPLETED', conclusion: '' }], 'pending'],
    [[{ conclusion: 'UNKNOWN' }], 'pending'], [[{ conclusion: 'STALE' }], 'fail'], [[{ conclusion: 'STARTUP_FAILURE' }], 'fail'],
    [[{ conclusion: 'SUCCESS' }, { state: 'PENDING' }], 'pending'],
  ]) {
    checks = rollup;
    assert.equal((await mod.exports.readPr('/repo', 1)).ci, expected);
  }
});

test('reviewer validation rejects unrelated accounts and request success requires GitHub confirmation', async () => {
  let pending = [];
  const mocks = { '../shared/headless.ts':headless, 'node:child_process':{execFile(){}}, 'node:util':{promisify:()=>async(_,args)=>({stdout:args[0]==='repo'?'org/repo':JSON.stringify(args[0]==='api'?{permission:args[1].includes('/ada/')?'write':'none',user:{login:args[1].split('/').at(-2),type:'User'}}:args[1]==='view'?{reviewRequests:pending.map(login=>({login}))}:{})})} };
  const mod={exports:{}};new Function('require','module','exports',code)(n=>mocks[n]??require(n),mod,mod.exports);
  assert.deepEqual(await mod.exports.validateReviewers('/repo',['do','and','ada']),['ada']);
  await assert.rejects(mod.exports.requestReviewers('/repo',1,['ada']),/did not record review requests/);
  pending=['ada'];await mod.exports.requestReviewers('/repo',1,['ada']);
});

test('git blame near changed lines outranks whole-file and repository contribution totals', async () => {
  const calls=[];
  const sha='a'.repeat(40), bob='b'.repeat(40), ada='c'.repeat(40);
  const mocks={ '../shared/headless.ts':headless, 'node:child_process':{execFile(){}}, 'node:util':{promisify:()=>async(cmd,args)=>{
    calls.push(args);
    let stdout='';
    if(cmd==='git') {
      if(args[0]==='merge-base') stdout=sha;
      else if(args[0]==='diff') stdout=args.includes('--unified=0')?'@@ -50 +50 @@\n-old\n+new\n':'src/map.ts\n';
      else if(args[0]==='show') stdout=Array(100).fill('line').join('\n')+'\n';
      else if(args[0]==='blame') stdout=`${bob} 30 30 1\nauthor-mail <bob@example.com>\n\tnearby\n${bob} 31 31 1\nauthor-mail <bob@example.com>\n\tnearby\n${ada} 32 32 1\nauthor-mail <1+ada@users.noreply.github.com>\n\tnearby\n`;
      else if(args[0]==='shortlog') stdout=' 999 Ada <1+ada@users.noreply.github.com>\n 500 Carol <2+carol@users.noreply.github.com>\n';
    } else if(args[0]==='repo') stdout='org/repo';
    else if(args.includes('--jq')) stdout='bob';
    else stdout=JSON.stringify([[{login:'carol',type:'User',contributions:10000},{login:'ada',type:'User',contributions:1000},{login:'bob',type:'User',contributions:2}]]);
    return {stdout};
  }}};
  const mod={exports:{}};new Function('require','module','exports',code)(n=>mocks[n]??require(n),mod,mod.exports);
  assert.deepEqual(await mod.exports.reviewerSuggestions('/repo','origin/main',[]),['bob','ada']);
  assert.ok(calls.some(a=>a[0]==='blame'&&a.includes('30,70')&&a.includes(sha)),'blame must use merge-base lines around the hunk');
  assert.ok(calls.some(a=>a[0]==='shortlog'&&a.includes('src')),'neighboring directory history supplies fallback reviewers');
  assert.ok(calls.some(a=>a.includes(`repos/org/repo/commits/${bob}`)),'regular emails are mapped through GitHub commit authors');
});

test('request function never re-requests approved or dismissed reviewers after later changes',async()=>{
  const calls=[];
  const mocks={'../shared/headless.ts':headless,'node:child_process':{execFile(){}},'node:util':{promisify:()=>async(_,args)=>{
    calls.push(args);
    return {stdout:JSON.stringify(args.includes('reviews')?{reviews:[{author:{login:'ada'},state:'APPROVED'},{author:{login:'bob'},state:'DISMISSED'}]}:args[1]==='view'?{reviewRequests:[{login:'carol'}]}:{})};
  }}};
  const mod={exports:{}};new Function('require','module','exports',code)(n=>mocks[n]??require(n),mod,mod.exports);
  assert.deepEqual(await mod.exports.requestReviewers('/repo',1,['ADA','bob']),[]);
  assert.ok(!calls.some(a=>a[1]==='edit'));
  assert.deepEqual(await mod.exports.requestReviewers('/repo',1,['ada','bob','carol']),['carol']);
  assert.deepEqual(calls.filter(a=>a[1]==='edit').map(a=>a.at(-1)),['carol']);
});
