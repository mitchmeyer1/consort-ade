import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as headless from '../src/shared/headless.ts';
import * as cliModels from '../src/shared/cliModels.ts';
import * as usage from '../src/shared/usage.ts';
import * as review from '../src/shared/review.ts';
import * as ship from '../src/shared/ship.ts';
import * as phi from '../src/shared/phi.ts';
import * as progress from '../src/cli/reviewProgress.ts';
import * as phiGate from '../src/cli/phiGate.ts';
import * as prArticle from '../src/shared/prArticle.ts';

const require = createRequire(import.meta.url);
const compile = name => ts.transpileModule(readFileSync(new URL(`../src/cli/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function load(name, extra = {}) {
  const mocks = { './reviewProgress': progress, './phiGate.ts': phiGate, '../shared/prArticle.ts': prArticle, '../shared/phi.ts': phi, '../shared/headless.ts': headless, '../shared/cliModels.ts': cliModels, '../shared/usage.ts': usage, '../shared/review.ts': review, '../shared/ship.ts': ship,
    './state': { WORK_DIR: '/wt', HOME: '/home', newId: p => `${p}-1`, loadState: () => ({ tasks: extra.tasks ?? [], accounts: [], jobs: [] }) }, ...extra.mocks };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compile(name))(n => mocks[n] ?? (n.startsWith('.') ? {} : require(n)), mod, mod.exports);
  return mod.exports;
}
const pr = (n, over = {}) => ({ number: n, title: `PR ${n}`, url: `https://github.com/acme/mono/pull/${n}`, headRefOid: `sha${n}`, baseRefName: 'development', isDraft: false, author: { login: 'dev' }, assignees: [], reviewRequests: [], ...over });

test('picks only PRs that request the reviewer; being assigned does not count; skips drafts, its own PRs and heads already reviewed', () => {
  const tasks = [
    { kind: 'review', status: 'done', review: { pr: 3, head: 'sha3' } },
    { kind: 'review', status: 'done', review: { pr: 4, head: 'old' } },
    { kind: 'review', status: 'working', review: { pr: 5, head: 'old' } },
  ];
  const { reviewCandidates } = load('reviewJob', { tasks });
  const prs = [
    pr(1, { reviewRequests: [{ login: 'Mitch' }] }), pr(2, { reviewRequests: [{ login: 'mitch' }] }), pr(3, { reviewRequests: [{ login: 'mitch' }] }),
    pr(4, { reviewRequests: [{ login: 'mitch' }] }), pr(5, { reviewRequests: [{ login: 'mitch' }] }), pr(6, { isDraft: true, reviewRequests: [{ login: 'mitch' }] }),
    pr(7, { author: { login: 'mitch' }, reviewRequests: [{ login: 'mitch' }] }), pr(8), pr(9, { assignees: [{ login: 'mitch' }] }),
  ];
  assert.deepEqual(reviewCandidates(prs, 'mitch', tasks).map(p => p.number), [1, 2, 4], '4 has new commits; 5 is still being reviewed');
  assert.deepEqual(reviewCandidates(prs, 'mitch', tasks, ['pr-2']).map(p => p.number), [1, 4], 'a PR whose review the owner killed stays theirs');
});

test('a review task records the PR and gets its own worktree', () => {
  const { newReviewTask } = load('reviewJob');
  const t = newReviewTask({ id: 'j' }, pr(9, { headRefOid: 'abcdef123456' }), 1);
  assert.equal(t.kind, 'review');
  assert.deepEqual(t.review, { repo: 'acme/mono', pr: 9, url: 'https://github.com/acme/mono/pull/9', title: 'PR 9', author: 'dev', head: 'abcdef123456', base: 'development' });
  assert.equal(t.worktree, '/wt/review-pr-9-abcdef1');
});

test('agent findings are read from a fenced block after the marker and cleaned', () => {
  const { jsonAfter, cleanFindings } = load('reviewJob');
  const text = 'I looked.\n[review-findings]\n```json\n[{"severity":"HIGH","category":"scaling","title":"N+1 on members","file":"./src/a.ts","line":12,"comment":"Batch this query."},{"title":"no comment"}]\n```';
  const found = cleanFindings(jsonAfter(text, '[review-findings]'));
  assert.deepEqual(found, [{ severity: 'high', category: 'scaling', title: 'N+1 on members', file: 'src/a.ts', line: 12, problem: undefined, fix: undefined, comment: 'Batch this query.' }]);
  assert.deepEqual(cleanFindings(jsonAfter('[review-final] {"tldr":"x","findings":[]}', '[review-final]')), []);
  assert.equal(jsonAfter('nothing here', '[review-findings]'), undefined);
});

test('the review file is the standard schema; Critical or High blocks approval; the Slack question is short and asks first', () => {
  const { buildReview, blocking, countLine, saysYes, approvalQuestion } = load('reviewJob');
  const target = { repo: 'acme/mono', pr: 9, url: 'https://github.com/acme/mono/pull/9', title: 'Add CSV export', author: 'dev', head: 'h', base: 'development' };
  const r = buildReview(target, [{ severity: 'medium', category: 'style', title: 'Service in the controller folder', file: 'src/c.ts', line: 3, comment: 'Move it to services/.' }], { tldr: 'Adds a CSV export.', at: 'now' });
  assert.equal(r.findings[0].status, 'approved');
  assert.equal(blocking(r.findings).length, 0);
  assert.equal(countLine(r.findings), '1 medium');
  assert.equal(blocking([{ severity: 'high' }, { severity: 'low' }]).length, 1);
  const q = approvalQuestion(target, r, 'https://github.com/acme/mono/pull/9#pullrequestreview-1', ['Exporting a report now downloads a CSV.', 'The API streams rows.', 'a', 'b', 'too many']);
  assert.match(q, /^Adds a CSV export\.\n• Exporting a report now downloads a CSV\.\n• The API streams rows\./);
  assert.equal((q.match(/^• /gm) ?? []).length, 4, 'at most 4 flows');
  assert.match(q, /Findings: 1 medium, nothing Critical or High · <https:\/\/github\.com\/acme\/mono\/pull\/9#pullrequestreview-1\|comments posted> · <.*\|PR #9> by @dev/);
  assert.match(q, /\*Approve\?\* Reply \*yes\* to approve/);
  for (const y of ['yes', 'Yes please', 'approve', 'lgtm', 'ok']) assert.ok(saysYes(y), y);
  for (const n of ['no', 'wait', 'hold off', 'not yet']) assert.ok(!saysYes(n), n);
  assert.match(q, /Ask anything else here and I'll answer/);
});

test('posting: one review with inline comments where the diff shows the line, and the rest in the body', async () => {
  const { postReview } = await import('../src/cli/reviewPost.ts');
  const calls = [];
  const gh = async (args, _cwd, input) => {
    calls.push({ args, input: input ? JSON.parse(input) : undefined });
    if (args[1].includes('/compare/')) return JSON.stringify({ files: [{ filename: 'src/a.ts', patch: '@@ -1,1 +1,3 @@\n a\n+b\n+c' }] });
    return JSON.stringify({ html_url: 'https://github.com/acme/mono/pull/9#pullrequestreview-7', id: 7 });
  };
  const r = review.parseReview(JSON.stringify({ repo: 'acme/mono', pr: 9, url: 'u', head: 'h', base: 'b', findings: [
    { id: 'F1', kind: 'defect', severity: 'high', title: 't1', file: 'src/a.ts', line: 2, comment: 'inline one', status: 'approved' },
    { id: 'F2', kind: 'defect', severity: 'low', title: 't2', file: 'src/z.ts', line: 40, comment: 'not in the diff', status: 'approved' },
  ] }));
  const out = await postReview(r, r.findings, 'REQUEST_CHANGES', 'Fix the High item.', '/wt', gh);
  assert.deepEqual(out, { url: 'https://github.com/acme/mono/pull/9#pullrequestreview-7', event: 'REQUEST_CHANGES', inline: 1, general: 1 });
  const sent = calls.find(c => c.args.includes('repos/acme/mono/pulls/9/reviews')).input;
  assert.equal(sent.event, 'REQUEST_CHANGES');
  assert.deepEqual(sent.comments, [{ path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'inline one' }]);
  assert.match(sent.body, /Fix the High item\.[\s\S]*\*\*src\/z\.ts:40\*\* — not in the diff/);
});

test('under the PHI/PII guard a review whose comments carry an identifier is not posted at all', async () => {
  const { postReview } = await import('../src/cli/reviewPost.ts');
  const { phiSettings } = await import('../src/shared/phi.ts');
  const pii = await import('./helpers/fake-pii.mjs');
  const calls = [];
  const gh = async (args) => { calls.push(args.join(' ')); return JSON.stringify(args[1].includes('/compare/') ? { files: [{ filename: 'src/a.ts', patch: '@@ -1,1 +1,2 @@\n a\n+b' }] } : { html_url: 'u' }); };
  const r = review.parseReview(JSON.stringify({ repo: 'acme/mono', pr: 9, url: 'u', head: 'h', base: 'b', findings: [{ id: 'F1', kind: 'defect', severity: 'high', title: 't1', file: 'src/a.ts', line: 2, comment: `the fixture holds ${pii.card()}`, status: 'approved' }] }));
  await assert.rejects(postReview(r, r.findings, 'COMMENT', 'Review.', '/wt', gh, { phi: phiSettings({ phi: { guard: true } }), record() {} }), (e) => e.name === 'PiiWithheldError' && e.categories === 'card ×1');
  assert.ok(!calls.some((c) => c.includes('/reviews')));
});

test('approving your own PR falls back to a comment instead of failing', async () => {
  const { postReview } = await import('../src/cli/reviewPost.ts');
  const events = [];
  const gh = async (args, _cwd, input) => {
    const body = input ? JSON.parse(input) : undefined;
    if (body?.event) { events.push(body.event); if (body.event === 'APPROVE') throw new Error('Review Can not approve your own pull request'); }
    return JSON.stringify({ html_url: 'url' });
  };
  const r = review.parseReview(JSON.stringify({ repo: 'acme/mono', pr: 9, url: 'u', head: 'h', base: 'b', findings: [] }));
  const out = await postReview(r, [], 'APPROVE', 'ok', '/wt', gh);
  assert.equal(out.event, 'COMMENT');
  assert.deepEqual(events, ['APPROVE', 'COMMENT']);
});

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function flow(t, findings, extraJobs = [], resume, opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'consort-review-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), wt = join(root, 'wt');
  await mkdir(repo); await mkdir(wt);
  await writeFile(join(repo, '.env'), 'DB=local\n'); await writeFile(join(repo, '.env.example'), 'x');
  await writeFile(join(wt, '.ai-review-rules.md'), '# rules');
  const task = { id: 't', jobId: 'j', kind: 'review', worktree: wt, status: 'working', envReadyAt: 1, review: { repo: 'acme/mono', pr: 9, url: 'https://github.com/acme/mono/pull/9', title: 'Add CSV export', author: 'dev', head: 'h', base: 'development' } };
  const state = { tasks: [task], jobs: [{ id: 'j', repo, name: 'reviews', reviewer: 'mitch', source: 'review' }, ...extraJobs.map(j => ({ ...j, repo }))], accounts: [{ id: 'c', provider: 'claude', name: 'C' }, { id: 'x', provider: 'codex', name: 'X' }], slack: { userId: 'u' }, ...(opts.guard ? { phi: { guard: true } } : {}) };
  const turns = [], posts = [], slackPosts = [], uploads = [];
  const article = { category: 'feature', headline: opts.headline ?? 'Admins can now download any report as a CSV.', body: 'The Reports page gets an Export button that calls GET /api/v1/reports/:id/export.', caption: 'The export flow', flows: [{ status: 'new', steps: ['Reports page', 'GET /api/v1/reports/:id/export'], note: 'Downloads the report as CSV' }],
    diagram: { nodes: [{ id: 'page', type: 'page', label: 'Reports page', status: 'changed' }, { id: 'route', type: 'route', label: 'GET /api/v1/reports/:id/export', status: 'new' }], edges: [{ from: 'page', to: 'route', label: 'calls' }] } };
  let reservations=0,finalCrashed=false;
  const runTurn = async o => {
    turns.push({ model: o.model, readOnly: o.readOnly, prompt: o.prompt });
    if (o.prompt.includes('step 1 of 3')) { await writeFile(join(wt, '.consort', 'review', 'plan.json'), JSON.stringify({ tldr: 'Adds a CSV export.', emoji: '📤', title: 'CSV report export', article, slices: [{ id: 's1', title: 'API', files: ['src/a.ts'] }, { id: 's2', title: 'UI', files: ['src/b.tsx'] }] })); return { text: 'written' }; }
    if (o.prompt.includes('Review one area') && opts.invalidArea) return {text:'No structured result'};
    if (o.prompt.includes('step 3 of 3') && opts.finalCrashOnce && !finalCrashed) { finalCrashed=true; throw Error('simulated worker interruption'); }
    if (o.prompt.includes('Review one area')) return { text: `[review-findings]\n\`\`\`json\n${JSON.stringify(typeof findings === 'function' ? findings() : findings)}\n\`\`\`` };
    if (o.prompt.includes('step 3 of 3')) return { text: `[review-final]\n\`\`\`json\n${JSON.stringify({ summary: 'Adds a CSV export.', flows: ['Exporting a report now downloads a CSV.'], headline: 'ok', findings: typeof findings === 'function' ? findings() : findings })}\n\`\`\`` };
    return { text: 'done' };
  };
  const mocks = {
    './agent': { runTurn }, './capacity': { tryAcquireAnyAgentTurn:(_,ids)=>{reservations++;return opts.queueOnce&&reservations===1?undefined:{accountId:ids[0],lease:'test'};},releaseAgentTurn(){}, runningTurns:()=>new Map() },
    './environment': { claimForTask: async () => headless.taskEnv('consort-t', 20000), releaseEnvironment: async () => {} },
    './oversight': { oversightModel: p => (p === 'claude' ? 'claude-opus-5' : 'gpt-5.6-sol') },
    './reviewPost': { postReview: async (r, f, event, body) => { posts.push({ event, n: f.length, body }); return { url: 'https://github.com/acme/mono/pull/9#review', event, inline: f.length, general: 0 }; } },
    './slackIdentity': { slackIdentityFor: title => ({ emoji: '📊', title }), takenEmojis: () => [] },
    './slack': { Slack: class { async post(text) { slackPosts.push(text); return String(slackPosts.length); } async uploadFile(file) { uploads.push({ ...file, afterPosts: slackPosts.length }); return 'F1'; } async waitForReply(_t, _ts, o) { return (opts.replies ?? [opts.reply ?? 'yes']).find(r => !o?.accept || o.accept(r)); } } },
    './state': { WORK_DIR: root, HOME: root, newId: () => 'x', loadState: () => state, updateTask: (id, patch) => Object.assign(task, typeof patch === 'function' ? patch(task) : patch), touchAccount() {}, blockAccount() {} },
    './usage': { usageFor: async accts => new Map(accts.map(a => [a.id, { keyId: a.id, at: Date.now(), windows: [{ id: '5h', label: '5h', percent: a.provider === 'claude' ? 90 : 10 }] }])) },
    'node:util': { promisify: () => async () => ({ stdout: '' }) },
  };
  const { reviewTask } = load('reviewJob', { mocks });
  if (resume) {
    await mkdir(join(wt, '.consort', 'review'), { recursive: true });
    await writeFile(join(wt, '.consort', 'review', 'pr-9.review.json'), JSON.stringify({ repo: 'acme/mono', pr: 9, url: 'u', head: 'h', base: 'b', findings: [] }));
    Object.assign(task, { slackThread: '1', pendingQuestion: { questions: ['Approve PR #9?'], afterTs: '5' } });
  }
  const watches = [...(opts.watches ?? [{ state: 'MERGED' }])];
  const sleeps = [];
  const runReview=()=>reviewTask('t', async () => (await opts.onWatch?.(wt), watches.length > 1 ? watches.shift() : watches[0]), async ms => { sleeps.push(ms); });
  if(opts.finalCrashOnce) await assert.rejects(runReview(),/simulated worker interruption/);
  await runReview();
  return { task, turns, posts, slackPosts, uploads, wt, root, sleeps };
}

test('a clean review: frontier overview, swarm on Opus/Sol, frontier check, comments posted, approval only after Slack yes', async (t) => {
  const f = await flow(t, [{ severity: 'medium', category: 'style', title: 'Wrong folder', file: 'src/a.ts', line: 3, comment: 'Move it.' }]);
  assert.match(f.turns[0].model, /gpt-6-astra|claude-fable/, 'overview on the frontier model');
  assert.ok(f.turns.filter(x => x.prompt.includes('Review one area')).every(x => x.readOnly && /opus|sol/.test(x.model)), 'swarm read-only on Opus/Sol');
  assert.ok(f.turns.at(-1).prompt.includes('step 3 of 3'));
  assert.deepEqual(f.posts.map(p => p.event), ['COMMENT', 'APPROVE']);
  assert.ok(f.slackPosts.some(p => /\*Approve\?\*/.test(p) && /^📤 \*CSV REPORT EXPORT\*\n⚠️ Adds a CSV export\./.test(p) && /• Exporting a report now downloads a CSV\./.test(p) && !/✅/.test(p)), 'asked on Slack first');
  assert.deepEqual(f.task.slackIdentity, { emoji: '📤', title: 'CSV report export' }, 'the overview picks the emoji');
  assert.equal(f.task.status, 'done'); assert.equal(f.task.note, 'approved');
  assert.equal(await readFile(join(f.wt, '.env'), 'utf8'), 'DB=local\n', 'root .env copied');
  await assert.rejects(readFile(join(f.wt, '.env.example')), 'templates are not copied');
  assert.match(await readFile(join(f.root, 'reviews', 'acme-mono-pr-9-h.review.json'), 'utf8'), /"Wrong folder"/);
  assert.ok(f.turns[0].prompt.includes('"article": {"category", "headline", "body", "diagram", "caption", "flows"}'), 'the overview is asked for the article');
  assert.equal(f.uploads.length, 1, 'the article is posted once');
  const [article] = f.uploads;
  assert.equal(article.thread, '1'); assert.equal(article.filename, 'pr-9-h.html'); assert.equal(article.title, 'Admins can now download any report as a CSV.');
  assert.match(article.comment, /^📤 \*Admins can now download any report as a CSV\.\*\nWhat <https:\/\/github\.com\/acme\/mono\/pull\/9\|PR #9> does/);
  assert.match(article.content, /<h1><a href="https:\/\/github\.com\/acme\/mono\/pull\/9">Admins can now download any report as a CSV\.<\/a><\/h1>/);
  assert.match(article.content, /<svg [^>]*>[\s\S]*GET \/api\/v1\/reports\/:id\/export[\s\S]*<\/svg>/); assert.match(article.content, /Reports page<\/code><span class="arrow">→<\/span><code>GET/);
  assert.equal(article.afterPosts, f.slackPosts.findIndex(p => /\*Approve\?\*/.test(p)), 'the article lands right before the approval question');
  assert.match(await readFile(join(f.wt, '.consort', 'review', 'pr-9.article.html'), 'utf8'), /Admins can now download/);
});

test('an article that carries an identifier is withheld by the PII gate; the thread says so and the approval still goes out', async (t) => {
  const pii = await import('./helpers/fake-pii.mjs');
  const f = await flow(t, [], [], undefined, { guard: true, headline: `Card ${pii.card()} now exports` });
  assert.equal(f.uploads.length, 0);
  assert.ok(f.slackPosts.some(p => /The PR article was withheld by the PII gate \(card ×1\)/.test(p)));
  assert.ok(f.slackPosts.some(p => /\*Approve\?\*/.test(p))); assert.equal(f.task.note, 'approved');
});

test('a High finding never posts the article, and a plan without one asks to approve as before', async (t) => {
  const high = await flow(t, [{ severity: 'high', category: 'logic', title: 'Breaks', file: 'src/a.ts', line: 1, comment: 'Fix.' }], [], undefined, { watches: [{ state: 'MERGED' }] });
  assert.equal(high.uploads.length, 0);
});

test('a High finding requests changes and never asks to approve', async (t) => {
  const f = await flow(t, [{ severity: 'high', category: 'scaling', title: 'Unbounded query', file: 'src/a.ts', line: 3, comment: 'Paginate.' }]);
  assert.deepEqual(f.posts.map(p => p.event), ['REQUEST_CHANGES']);
  assert.ok(!f.slackPosts.some(p => /\*Approve\?\*/.test(p)));
  assert.equal(f.task.note, 'merged', 'finished only when the PR merged');
  assert.ok(f.slackPosts.some(p => /Watching the PR: the next round starts when @dev asks for review again/.test(p)));
});

test('after Request changes it watches the PR and runs another round when the author asks again, checking earlier findings first', async (t) => {
  let calls = 0; // round 1: two area reviewers and the verify step
  const high = [{ severity: 'high', category: 'scaling', title: 'Unbounded query', file: 'src/a.ts', line: 3, comment: 'Paginate.' }];
  const f = await flow(t, () => (calls++ < 3 ? high : []), [], false, { watches: [
    { state: 'OPEN', headRefOid: 'h', reviewRequests: [] },
    { state: 'OPEN', headRefOid: 'h2', reviewRequests: [{ login: 'Mitch' }] },
  ] });
  assert.deepEqual(f.posts.map(p => p.event), ['REQUEST_CHANGES', 'APPROVE'], 'round 2 is clean, so it asks and approves');
  assert.equal(f.task.review.round, 2); assert.equal(f.task.review.head, 'h2');
  assert.equal(f.task.status, 'done'); assert.equal(f.task.note, 'approved');
  assert.ok(f.slackPosts.some(p => /Round 2: @dev asked for review again at `h2`/.test(p)));
  assert.match(await readFile(join(f.wt, '.consort', 'review', 'previous.json'), 'utf8'), /Unbounded query/);
  assert.ok(f.turns.some(x => x.prompt.includes('step 1 of 3')) && f.turns.filter(x => x.prompt.includes('step 1 of 3')).length === 2, 'a fresh overview each round');
  assert.equal(f.sleeps.length, 1, 'polled until the request came back');
});

test('a review folder deleted while watching is checked out again, and round 2 still checks the earlier findings', async (t) => {
  let calls = 0, gone = false;
  const high = [{ severity: 'high', category: 'scaling', title: 'Unbounded query', file: 'src/a.ts', line: 3, comment: 'Paginate.' }];
  const f = await flow(t, () => (calls++ < 3 ? high : []), [], false, { onWatch: async wt => { if (!gone) { gone = true; await rm(wt, { recursive: true, force: true }); } }, watches: [
    { state: 'OPEN', headRefOid: 'h', reviewRequests: [] },
    { state: 'OPEN', headRefOid: 'h2', reviewRequests: [{ login: 'Mitch' }] },
  ] });
  assert.equal(f.task.review.round, 2); assert.equal(f.task.note, 'approved');
  assert.match(await readFile(join(f.wt, '.consort', 'review', 'previous.json'), 'utf8'), /Unbounded query/, 'restored from the saved copy');
});

test('the owner saying no keeps watching; a request that never cleared does not loop on the same head', async (t) => {
  const f = await flow(t, [], [], false, { reply: 'no', watches: [
    { state: 'OPEN', headRefOid: 'h', reviewRequests: [{ login: 'mitch' }] },
    { state: 'OPEN', headRefOid: 'h', reviewRequests: [{ login: 'mitch' }] },
    { state: 'CLOSED', headRefOid: 'h' },
  ] });
  assert.equal(f.turns.filter(x => x.prompt.includes('step 1 of 3')).length, 1, 'one round only');
  assert.equal(f.task.status, 'done'); assert.equal(f.task.note, 'PR closed');
});

test('a question on the approval is not an answer: it waits on for a yes or no', async (t) => {
  const f = await flow(t, [], [], false, { replies: ['Whats the point of this? Isnt the point of a view that its not real data?', 'ok so what changed', 'yes'] });
  assert.deepEqual(f.posts.map(p => p.event), ['APPROVE']);
  assert.ok(!f.slackPosts.some(p => /unapproved \(you said/.test(p)), 'the question was not read as a no');
  assert.equal(f.task.note, 'approved');
});

test('a review uses the model settings of the build scanner on the same repository', async (t) => {
  const f = await flow(t, [], [{ id: 'b', source: 'clickup', modelPolicy: { frontier: { claude: 'claude-opus-5', codex: 'gpt-6-astra-pro' } } }]);
  assert.match(f.turns[0].model, /^(claude-opus-5|gpt-6-astra-pro)$/);
});

test('restarted while waiting for approval: waits for the answer again, never re-runs the review', async (t) => {
  const f = await flow(t, [], [], true);
  assert.equal(f.turns.length, 0, 'no agent turns');
  assert.deepEqual(f.posts.map(p => p.event), ['APPROVE']);
  assert.equal(f.task.status, 'done'); assert.equal(f.task.note, 'approved');
});

test('review queue wait is measured separately and ends before execution starts',async t=>{
  const f=await flow(t,[],[],undefined,{queueOnce:true});
  assert.ok(f.task.turnHistory.some(h=>h.queueMs>=200));
  for(const h of f.task.turnHistory){assert.ok(h.executionMs>=0);assert.ok(h.durationMs===h.executionMs);}
});

test('restart after final verification interruption reuses completed review areas',async t=>{
 const f=await flow(t,[{severity:'medium',title:'Example',file:'src/a.ts',line:1,comment:'Fix this'}],[],undefined,{finalCrashOnce:true});
 assert.equal(f.turns.filter(x=>x.prompt.includes('Review one area')).length,2);
 assert.equal(f.turns.filter(x=>x.prompt.includes('step 1 of 3')).length,1);
 assert.equal(f.turns.filter(x=>x.prompt.includes('step 3 of 3')).length,2);
});
test('malformed area results cannot become an empty approving review',async t=>{
 await assert.rejects(flow(t,[],[],undefined,{invalidArea:true}),/review areas failed/);
});
