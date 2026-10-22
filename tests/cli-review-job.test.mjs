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

const require = createRequire(import.meta.url);
const compile = name => ts.transpileModule(readFileSync(new URL(`../src/cli/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function load(name, extra = {}) {
  const mocks = { '../shared/headless.ts': headless, '../shared/cliModels.ts': cliModels, '../shared/usage.ts': usage, '../shared/review.ts': review, '../shared/ship.ts': ship,
    './state': { WORK_DIR: '/wt', HOME: '/home', newId: p => `${p}-1`, loadState: () => ({ tasks: extra.tasks ?? [], accounts: [], jobs: [] }) }, ...extra.mocks };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compile(name))(n => mocks[n] ?? (n.startsWith('.') ? {} : require(n)), mod, mod.exports);
  return mod.exports;
}
const pr = (n, over = {}) => ({ number: n, title: `PR ${n}`, url: `https://github.com/acme/mono/pull/${n}`, headRefOid: `sha${n}`, baseRefName: 'development', isDraft: false, author: { login: 'dev' }, assignees: [], reviewRequests: [], ...over });

test('picks PRs assigned to the reviewer or asking it for review; skips drafts, its own PRs and heads already reviewed', () => {
  const tasks = [
    { kind: 'review', status: 'done', review: { pr: 3, head: 'sha3' } },
    { kind: 'review', status: 'done', review: { pr: 4, head: 'old' } },
    { kind: 'review', status: 'working', review: { pr: 5, head: 'old' } },
  ];
  const { reviewCandidates } = load('reviewJob', { tasks });
  const prs = [
    pr(1, { assignees: [{ login: 'Mitch' }] }), pr(2, { reviewRequests: [{ login: 'mitch' }] }), pr(3, { assignees: [{ login: 'mitch' }] }),
    pr(4, { assignees: [{ login: 'mitch' }] }), pr(5, { assignees: [{ login: 'mitch' }] }), pr(6, { isDraft: true, assignees: [{ login: 'mitch' }] }),
    pr(7, { author: { login: 'mitch' }, assignees: [{ login: 'mitch' }] }), pr(8),
  ];
  assert.deepEqual(reviewCandidates(prs, 'mitch', tasks).map(p => p.number), [1, 2, 4], '4 has new commits; 5 is still being reviewed');
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
  const q = approvalQuestion(target, r, 'https://github.com/acme/mono/pull/9#pullrequestreview-1');
  assert.match(q, /^\*Approve PR #9\?\* Add CSV export by @dev/);
  assert.match(q, /TL;DR: Adds a CSV export\./);
  assert.match(q, /1 medium; nothing Critical or High\. Comments are posted/);
  assert.match(q, /Reply \*yes\* to approve/);
  for (const y of ['yes', 'Yes please', 'approve', 'lgtm', 'ok']) assert.ok(saysYes(y), y);
  for (const n of ['no', 'wait', 'hold off', 'not yet']) assert.ok(!saysYes(n), n);
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

async function flow(t, findings) {
  const root = await mkdtemp(join(tmpdir(), 'consort-review-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), wt = join(root, 'wt');
  await mkdir(repo); await mkdir(wt);
  await writeFile(join(repo, '.env'), 'DB=local\n'); await writeFile(join(repo, '.env.example'), 'x');
  await writeFile(join(wt, '.ai-review-rules.md'), '# rules');
  const task = { id: 't', jobId: 'j', kind: 'review', worktree: wt, status: 'working', envReadyAt: 1, review: { repo: 'acme/mono', pr: 9, url: 'https://github.com/acme/mono/pull/9', title: 'Add CSV export', author: 'dev', head: 'h', base: 'development' } };
  const state = { tasks: [task], jobs: [{ id: 'j', repo, name: 'reviews', reviewer: 'mitch' }], accounts: [{ id: 'c', provider: 'claude', name: 'C' }, { id: 'x', provider: 'codex', name: 'X' }], slack: { userId: 'u' } };
  const turns = [], posts = [], slackPosts = [];
  const runTurn = async o => {
    turns.push({ model: o.model, readOnly: o.readOnly, prompt: o.prompt });
    if (o.prompt.includes('step 1 of 3')) { await writeFile(join(wt, '.consort', 'review', 'plan.json'), JSON.stringify({ tldr: 'Adds a CSV export.', slices: [{ id: 's1', title: 'API', files: ['src/a.ts'] }, { id: 's2', title: 'UI', files: ['src/b.tsx'] }] })); return { text: 'written' }; }
    if (o.prompt.includes('Review one area')) return { text: `[review-findings]\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\`` };
    if (o.prompt.includes('step 3 of 3')) return { text: `[review-final]\n\`\`\`json\n${JSON.stringify({ tldr: 'Adds a CSV export.', headline: 'ok', findings })}\n\`\`\`` };
    return { text: 'done' };
  };
  const mocks = {
    './agent': { runTurn }, './capacity': { withAgentTurn: async (_, __, fn) => fn() },
    './environment': { allocateEnvironment: async () => headless.taskEnv('consort-t', 20000), cleanupEnvironment: async () => ({}) },
    './oversight': { oversightModel: p => (p === 'claude' ? 'claude-opus-5' : 'gpt-5.6-sol') },
    './reviewPost': { postReview: async (r, f, event, body) => { posts.push({ event, n: f.length, body }); return { url: 'https://github.com/acme/mono/pull/9#review', event, inline: f.length, general: 0 }; } },
    './slack': { Slack: class { async post(text) { slackPosts.push(text); return String(slackPosts.length); } async waitForReply() { return 'yes'; } } },
    './state': { WORK_DIR: root, HOME: root, newId: () => 'x', loadState: () => state, updateTask: (id, patch) => Object.assign(task, typeof patch === 'function' ? patch(task) : patch), touchAccount() {}, blockAccount() {} },
    './usage': { usageFor: async accts => new Map(accts.map(a => [a.id, { keyId: a.id, at: Date.now(), windows: [{ id: '5h', label: '5h', percent: a.provider === 'claude' ? 90 : 10 }] }])) },
    'node:util': { promisify: () => async () => ({ stdout: '' }) },
  };
  const { reviewTask } = load('reviewJob', { mocks });
  await reviewTask('t');
  return { task, turns, posts, slackPosts, wt, root };
}

test('a clean review: frontier overview, swarm on Opus/Sol, frontier check, comments posted, approval only after Slack yes', async (t) => {
  const f = await flow(t, [{ severity: 'medium', category: 'style', title: 'Wrong folder', file: 'src/a.ts', line: 3, comment: 'Move it.' }]);
  assert.match(f.turns[0].model, /gpt-6-astra|claude-fable/, 'overview on the frontier model');
  assert.ok(f.turns.filter(x => x.prompt.includes('Review one area')).every(x => x.readOnly && /opus|sol/.test(x.model)), 'swarm read-only on Opus/Sol');
  assert.ok(f.turns.at(-1).prompt.includes('step 3 of 3'));
  assert.deepEqual(f.posts.map(p => p.event), ['COMMENT', 'APPROVE']);
  assert.ok(f.slackPosts.some(p => /Approve PR #9\?/.test(p)), 'asked on Slack first');
  assert.equal(f.task.status, 'done'); assert.equal(f.task.note, 'approved');
  assert.equal(await readFile(join(f.wt, '.env'), 'utf8'), 'DB=local\n', 'root .env copied');
  await assert.rejects(readFile(join(f.wt, '.env.example')), 'templates are not copied');
  assert.match(await readFile(join(f.root, 'reviews', 'acme-mono-pr-9-h.review.json'), 'utf8'), /"Wrong folder"/);
});

test('a High finding requests changes and never asks to approve', async (t) => {
  const f = await flow(t, [{ severity: 'high', category: 'scaling', title: 'Unbounded query', file: 'src/a.ts', line: 3, comment: 'Paginate.' }]);
  assert.deepEqual(f.posts.map(p => p.event), ['REQUEST_CHANGES']);
  assert.ok(!f.slackPosts.some(p => /Approve PR/.test(p)));
  assert.match(f.task.note, /requested changes/);
});
