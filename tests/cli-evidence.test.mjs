import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as headless from '../src/shared/headless.ts';
import * as ship from '../src/shared/ship.ts';
import * as phiGate from '../src/cli/phiGate.ts';
import { phiSettings } from '../src/shared/phi.ts';
import * as pii from './helpers/fake-pii.mjs';
const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL('../src/cli/evidence.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'consort-evidence-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const dir = join(root, headless.EVIDENCE_DIR);
  mkdirSync(dir, { recursive: true });
  const manifest = { status: 'passed', kind: 'frontend', summary: 'Map loads and shows the selected group.', blockers: [], stories: [{ actor: 'user', story: 'Show locations on a map', status: 'passed', expected: 'Visible map with locations', observed: 'Map loaded and markers appeared', items: ['Working map'] }], items: [{ title: 'Working map', image: 'map.png' }] };
  const save = () => writeFileSync(join(root, headless.EVIDENCE_MANIFEST), JSON.stringify(manifest));
  save();
  writeFileSync(join(dir, 'map.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT1sAAAAASUVORK5CYII=', 'base64'));
  const calls = [];
  const comments = [];
  const mocks = { '../shared/headless.ts': headless, '../shared/ship.ts': ship, './phiGate.ts': phiGate,
    'node:util': { promisify: () => async (cmd, args) => {
      calls.push(args);
      if (cmd === 'git') {
        if (args[0] === 'push' && options.uploadFails) throw new Error('Upload denied');
        if (args[0] === 'push' && options.pushFailsOnce && !options.pushedOnce) { options.pushedOnce = true; throw new TypeError('fetch failed'); }
        return { stdout: args[0] === 'remote' ? 'git@github.com:acme/app.git\n' : args[0] === 'commit-tree' ? 'c0ffee1\n' : args[0] === 'rev-parse' && options.noBranch ? '' : args[0] === 'hash-object' ? 'b10b\n' : '' };
      }
      if (options.prFails) throw new Error('PR comment rejected');
      if (args[0] === 'api' && args[1] === 'user') return { stdout: 'consort-bot\n' };
      if (args[0] === 'api' && args[1] === '--paginate') return { stdout: options.prComments ?? '' };
      if (args[0] === 'pr' && args[1] === 'view') return { stdout: options.prBody ?? '' };
      if (args[0] === 'pr' && args[1] === 'comment') return { stdout: 'https://github.com/acme/app/pull/1#issuecomment-900\n' };
      return { stdout: '' };
    } },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'fetch', code)(n => mocks[n] ?? require(n), mod, mod.exports, async () => { calls.push('upload'); if (options.fetch) return options.fetch(); return options.uploadFails ? { ok: false, status: 403, text: async () => 'Upload denied' } : { ok: true, text: async () => JSON.stringify({ url: 'https://image.example/map.png' }) }; });
  const args = { worktree: root, repo: root, ticket: { source: 'clickup', id: '1', title: 'Map', url: 'https://ticket/1' }, pr: 1, prUrl: 'https://pr/1', clickupKey: 'test', source: { comment: async (_, text) => { comments.push(text); calls.push('ticket'); if (options.ticketFails) throw new Error('Ticket unavailable'); return options.ticketCommentId; }, ...(options.ticketCommentId ? { editComment: async (_, id, text) => { calls.push(['ticket-edit', id]); comments[comments.length - 1] = text; } } : {}) } };
  return { api: mod.exports, root, dir, manifest, save, args, calls, comments };
}

test('manifest rejects missing stories, failed stories, blockers, and frontend text-only output', () => {
  assert.ok(headless.evidenceProblems(undefined).length);
  const base = { status: 'passed', kind: 'backend', summary: 'A real response', items: [{ title: 'Response', text: '200 OK' }], stories: [{ actor: 'user', story: 'A partner calls the API → it answers', status: 'passed', expected: '200', observed: '200', items: ['Response'] }] };
  assert.deepEqual(headless.evidenceProblems(headless.parseEvidenceManifest(base)), []);
  for (const override of [{ status: 'blocked' }, { stories: [] }, { blockers: ['API KEY REQUIRED'] }, { kind: 'frontend' }, { stories: [{ ...base.stories[0], status: 'failed' }] }, { stories: [{ ...base.stories[0], items: ['missing'] }] }]) {
    assert.ok(headless.evidenceProblems(headless.parseEvidenceManifest({ ...base, ...override })).length);
  }
});

test('evidence holds only user stories: every item shows one, and a scheduled job with no screen needs a diagram', () => {
  const problems = (m) => headless.evidenceProblems(headless.parseEvidenceManifest(m));
  const cron = { actor: 'cron', story: 'Every day at 7 AM, Mono syncs appointments', status: 'passed', expected: 'rows upserted', observed: '12 rows upserted', items: ['Run output'] };
  const base = { status: 'passed', kind: 'backend', summary: 'The daily sync ran.', stories: [cron], items: [{ title: 'Run output', image: 'run.png', text: 'upserted 12' }] };
  assert.deepEqual(problems(base), ["A scheduled job's story needs a generated diagram of its data and logic: Every day at 7 AM, Mono syncs appointments"], 'a terminal image is not a diagram');
  const diagram = { title: 'How the sync works', image: 'erd.png', diagram: true };
  assert.deepEqual(problems({ ...base, stories: [{ ...cron, items: ['Run output', 'How the sync works'] }], items: [...base.items, diagram] }), []);
  assert.deepEqual(problems({ ...base, stories: [{ ...cron, items: ['Run output', 'Result page'] }], items: [...base.items, { title: 'Result page', image: 'page.png' }] }), [], 'a screenshot of where the result shows also does');
  assert.deepEqual(problems({ ...base, stories: [{ ...cron, actor: 'user' }] }), [], 'a user story needs no diagram');
  assert.deepEqual(problems({ ...base, stories: [{ ...cron, items: ['Run output', 'How the sync works'] }], items: [...base.items, diagram, { title: 'Test suite passes', text: '153 passed' }] }), ['Evidence item belongs to no user story: Test suite passes']);
  assert.equal(headless.parseEvidenceManifest({ items: [{ title: 'x', text: 'y', diagram: true }] }).items[0].diagram, undefined, 'only an image can be a diagram');
  assert.deepEqual(problems({ ...base, kind: 'frontend', stories: [{ ...cron, items: ['Run output', 'How the sync works'] }], items: [...base.items, diagram] }), ['Frontend evidence needs screenshots of the working feature.'], 'a diagram is not a screenshot of the app');
});

test('the helper draws diagrams, and the one comment is found under its new and old headings', async t => {
  const f = fixture(t, { prComments: '11\tconsort-bot\tfalse\ttrue\n' });
  const helper = readFileSync(f.api.writeScreenshotHelper(f.root, '/usr/bin/true'), 'utf8');
  assert.match(helper, /args\[0\] === "--erd"/);
  assert.doesNotThrow(() => new Function('require', 'process', helper.replace(/^#!.*\n/, '')).bind(null, () => { throw new Error('parsed, not run'); }));
  await f.api.publishEvidence(f.args);
  const list = f.calls.find((c) => Array.isArray(c) && c[0] === 'api' && c[1] === '--paginate');
  assert.ok(list.at(-1).includes('startswith("## User stories")') && list.at(-1).includes('startswith("## Evidence")'));
  assert.ok(f.calls.some((c) => Array.isArray(c) && c.includes('PATCH') && c.some((a) => String(a).includes('issues/comments/11'))), 'the old comment is edited, not joined by a second one');
  assert.match(readFileSync(join(f.dir, '.pr-comment.md'), 'utf8'), /^## User stories\n/);
});

test('missing or empty evidence images block before any external publication', async t => {
  const f = fixture(t);
  rmSync(join(f.dir, 'map.png'));
  await assert.rejects(f.api.publishEvidence(f.args), /image is missing/);
  assert.equal(f.calls.length, 0);
  writeFileSync(join(f.dir, 'map.png'), '');
  await assert.rejects(f.api.publishEvidence(f.args), /empty/);
  assert.equal(f.calls.length, 0);
});

test('evidence images cannot follow a symlink out of the evidence folder', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'private.txt'), 'private fixture');
  rmSync(join(f.dir, 'map.png'));
  symlinkSync(join(f.root, 'private.txt'), join(f.dir, 'map.png'));
  await assert.rejects(f.api.publishEvidence(f.args), /inside the evidence directory/);
  assert.equal(f.calls.length, 0);
});

test('broken map evidence is rejected before uploading or posting success', async t => {
  const f = fixture(t);
  f.manifest.status = 'blocked';
  f.manifest.blockers = ['CARTO tiles display API KEY REQUIRED; basemap requirement is not met'];
  f.save();
  await assert.rejects(f.api.publishEvidence(f.args), /API KEY REQUIRED/);
  assert.equal(f.calls.length, 0);
});

for (const [key, message] of [['uploadFails', /Upload denied/], ['prFails', /PR comment rejected/], ['ticketFails', /Ticket unavailable/]]) {
  test(`${key} prevents evidence completion`, async t => {
    const f = fixture(t, { [key]: true });
    await assert.rejects(f.api.publishEvidence(f.args), message);
    if (key === 'uploadFails') assert.ok(!f.calls.some(c => Array.isArray(c) && c[0] === 'pr'), 'no PR comment after a failed upload');
  });
}

test('working evidence publishes images and both comments', async t => {
  const f = fixture(t);
  f.args.cost = { usd: 0, turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  f.args.timing = { startedAt: Date.UTC(2026, 9, 21, 12), endedAt: Date.UTC(2026, 9, 21, 13, 2, 3) };
  const published = await f.api.publishEvidence(f.args);
  assert.deepEqual(published, { items: 1, images: 1, prComment: true, ticketComment: true, hosting: 'branch', descriptionCleaned: 0 });
  assert.ok(readFileSync(join(f.dir, '.pr-comment.md'), 'utf8').includes('https://github.com/acme/app/blob/c0ffee1/1/map.png?raw=true'), 'a github.com link pinned to the commit, which renders in a private repo');
  assert.ok(!f.calls.includes('upload'), 'nothing is uploaded to ClickUp');
  assert.ok(f.calls.some(c => Array.isArray(c) && c[0] === 'push' && c[1] === '--no-verify' && c[3] === 'c0ffee1:refs/heads/consort-evidence'));
  assert.equal(f.calls.at(-2), 'ticket');
  assert.deepEqual(f.calls.at(-1).slice(0, 2), ['pr', 'view'], 'the description is checked for repeated evidence last');
  for (const text of [readFileSync(join(f.dir, '.pr-comment.md'), 'utf8'), f.comments[0]]) {
    assert.match(text.replace(/  \n/g, "\n"), /Agent cost:[^\n]+\nStart time: 2026-10-21 12:00:00 UTC\nEnd time \(evidence ready\): 2026-10-21 13:02:03 UTC\nDuration \(including pauses\): 1h 2m 3s/);
  }
});

test('credential recovery names the root path and requires confirmation without sharing secrets', () => {
  const prompt = headless.EVIDENCE_PROMPT({ helper: '/helper', ticketUrl: 'ticket', prUrl: 'pr', worktree: '/task', repoRoot: '/repo' });
  assert.match(prompt, /\/repo\/\.env/);
  assert.match(prompt, /Only after that confirmation, copy the required named variable/);
  assert.match(prompt, /Never ask for a secret in Slack/);
  assert.match(prompt, /never copy the entire root env file/i);
  assert.match(headless.VERIFY_EVIDENCE_PROMPT, /Read every image using image tools/);
});

test('a failed push to GitHub posts nothing; the retry pushes and posts both comments', async t => {
  const f = fixture(t, { pushFailsOnce: true });
  f.manifest.items.push({ title: 'Second view', image: 'second.png' }); f.manifest.stories[0].items.push('Second view');
  writeFileSync(join(f.dir, 'second.png'), readFileSync(join(f.dir, 'map.png')));
  f.save();
  await assert.rejects(f.api.publishEvidence(f.args), /fetch failed/);
  assert.equal(f.comments.length, 0);
  assert.ok(!f.calls.some(c => Array.isArray(c) && c[0] === 'pr'));
  const result = await f.api.publishEvidence(f.args);
  assert.equal(result.images, 2);
  assert.equal(f.comments.length, 1);
});

test('ticket comment retry reuses images and does not repost the successful PR comment', async t => {
  const f = fixture(t);
  let attempts = 0;
  f.args.source.comment = async () => { if (++attempts === 1) throw new TypeError('fetch failed'); };
  await assert.rejects(f.api.publishEvidence(f.args), /fetch failed/);
  await f.api.publishEvidence(f.args);
  assert.equal(f.calls.filter(c => Array.isArray(c) && c[0] === 'push').length, 1);
  assert.equal(f.calls.filter(c => Array.isArray(c) && c[0] === 'pr' && c[1] === 'comment').length, 1);
  assert.equal(attempts, 2);
});

test('changed image contents invalidate a saved upload receipt', async t => {
  const f = fixture(t);
  await f.api.publishEvidence(f.args);
  writeFileSync(join(f.dir, 'map.png'), Buffer.from('changed image fixture'));
  await f.api.publishEvidence(f.args);
  assert.equal(f.calls.filter(c => Array.isArray(c) && c[0] === 'push').length, 2);
});

test('under the PHI/PII guard, evidence text carrying an identifier stops before any upload or comment', async t => {
  const f = fixture(t);
  f.manifest.summary = `Map loads for the member at ${pii.address()}`;
  f.save();
  const gate = { phi: phiSettings({ phi: { guard: true } }), record() {} };
  await assert.rejects(f.api.publishEvidence({ ...f.args, gate }), (e) => e instanceof phiGate.PiiWithheldError && /^address ×\d$/.test(e.categories));
  assert.equal(f.calls.length, 0);
  f.manifest.summary = 'Map loads and shows the selected group.';
  f.save();
  assert.equal((await f.api.publishEvidence({ ...f.args, gate })).prComment, true);
});

test('a second publish of unchanged images reuses their GitHub links; old ClickUp links are replaced', async t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, '.publication.json'), JSON.stringify({ destination: JSON.stringify(['clickup', '1', 'https://pr/1']), images: { 'map.png': { hash: 'x', url: 'https://t9013448339.p.clickup-attachments.com/map.png' } } }));
  await f.api.publishEvidence(f.args);
  assert.ok(f.calls.some(c => Array.isArray(c) && c[0] === 'push'), 'a ClickUp link is re-hosted on GitHub');
  const pushes = () => f.calls.filter(c => Array.isArray(c) && c[0] === 'push').length;
  const before = pushes();
  await f.api.publishEvidence(f.args);
  assert.equal(pushes(), before, 'unchanged images are not pushed again');
});

const ghCalls = (f, ...head) => f.calls.filter(c => Array.isArray(c) && head.every((h, i) => c[i] === h));

test('the first publish posts one evidence comment carrying the hidden marker', async t => {
  const f = fixture(t);
  await f.api.publishEvidence(f.args);
  assert.equal(ghCalls(f, 'pr', 'comment').length, 1);
  assert.equal(ghCalls(f, 'api', '-X', 'PATCH').length, 0);
  assert.ok(readFileSync(join(f.dir, '.pr-comment.md'), 'utf8').trimEnd().endsWith(f.api.EVIDENCE_MARKER));
});

test('a later publish edits the existing evidence comment in place and removes extra copies', async t => {
  // 11: someone else's comment; 12: our marked evidence; 13: a reviewer quoting the heading; 14: an old unmarked copy of ours
  const f = fixture(t, { prComments: ['11\talice\tfalse\tfalse', '12\tconsort-bot\ttrue\ttrue', '13\talice\tfalse\ttrue', '14\tconsort-bot\tfalse\ttrue'].join('\n') + '\n' });
  await f.api.publishEvidence({ ...f.args, head: 'abcdef1234567890' });
  assert.equal(ghCalls(f, 'pr', 'comment').length, 0, 'no new comment below the old one');
  const patches = ghCalls(f, 'api', '-X', 'PATCH');
  assert.equal(patches.length, 1);
  assert.equal(patches[0][3], 'repos/{owner}/{repo}/issues/comments/12', 'the oldest of ours is the one kept');
  assert.deepEqual(ghCalls(f, 'api', '-X', 'DELETE').map(c => c[3]), ['repos/{owner}/{repo}/issues/comments/14'], "only our extra copy goes; other people's comments stay");
  assert.match(readFileSync(join(f.dir, '.pr-comment.md'), 'utf8'), /current as of commit abcdef123\./);
});

test('changed evidence rewrites the same PR comment and the same ticket comment', async t => {
  const f = fixture(t, { ticketCommentId: 'c-77' });
  await f.api.publishEvidence(f.args);
  f.manifest.summary = 'Map loads with the new filter applied.';
  f.save();
  f.calls.length = 0;
  await f.api.publishEvidence(f.args);
  assert.deepEqual(f.calls.filter(c => Array.isArray(c) && c[0] === 'ticket-edit'), [['ticket-edit', 'c-77']]);
  assert.equal(f.calls.filter(c => c === 'ticket').length, 0, 'no second ticket comment');
  assert.ok(f.comments.at(-1).includes('new filter applied'));
  assert.equal(f.comments.length, 1);
});

test('the refresh prompt tells the agent to edit in place and never add a comment', () => {
  const prompt = headless.EVIDENCE_REFRESH_PROMPT({ helper: '/tmp/shot.cjs', prUrl: 'https://pr/1', pr: 1, since: 'abc123' });
  assert.match(prompt, /git diff abc123\.\.HEAD/);
  assert.match(prompt, /Never post a new top-level comment/);
  assert.match(prompt, /issues\/1\/comments/);
  assert.ok(headless.evidenceCurrent(`all good\n${headless.EVIDENCE_CURRENT}`));
  assert.ok(!headless.evidenceCurrent('recaptured item 2'));
});

const DESCRIPTION = ['## What this does', 'Adds a filter to list pages.', '', '## Screenshots', '', '| Before | After |', '|---|---|', '| ![before](https://github.com/acme/app/blob/c0ffee1/1/before.png?raw=true) | ![after](https://github.com/acme/app/blob/c0ffee1/1/after.png?raw=true) |', '', '### Mobile', '![m](https://github.com/acme/app/blob/c0ffee1/1/m.png?raw=true)', '', '## Testing', 'pnpm test passes.', '![diagram](https://user-images.example/arch.png)', '![stray](https://github.com/acme/app/blob/c0ffee1/1/stray.png?raw=true)', '', '```md', '## Evidence', '![x](https://github.com/acme/app/blob/c0ffee1/1/x.png?raw=true)', '```', ''].join('\n');

test('evidence in a PR description is replaced by one line pointing at the evidence comment', () => {
  const url = 'https://pr/1#issuecomment-900';
  const { body, removed } = headless.stripEvidenceFromDescription(DESCRIPTION, url);
  assert.equal(removed, 2, 'the Screenshots section and the stray evidence image');
  assert.ok(!/## Screenshots|### Mobile|before\.png|stray\.png/.test(body));
  assert.ok(body.includes('## What this does') && body.includes('## Testing') && body.includes('pnpm test passes.'));
  assert.ok(body.includes('arch.png'), 'an image that is not evidence stays');
  assert.ok(body.includes('x.png'), 'a code block is left alone');
  assert.equal(body.split(headless.EVIDENCE_POINTER_MARKER).length - 1, 1, 'one pointer line');
  assert.ok(body.indexOf(url) < body.indexOf('## Testing'), 'the pointer sits where the section was');
  assert.deepEqual(headless.stripEvidenceFromDescription(body, url), { body, removed: 0 }, 'a clean description is not touched again');
  assert.equal(headless.stripEvidenceFromDescription('## Summary\nNo proof here.\n', url).removed, 0);
  const stories = headless.stripEvidenceFromDescription('## Summary\nBuilt it.\n\n## User stories\n1. An admin exports the roster.\n\n## Testing\nok\n', url);
  assert.equal(stories.removed, 1, 'the user stories are not repeated in the description either');
  assert.ok(!stories.body.includes('An admin exports') && stories.body.includes('## Testing') && stories.body.includes('[the user stories comment]'));
});

test('publishing evidence cleans a description that repeats it, and leaves a clean one alone', async t => {
  const f = fixture(t, { prBody: DESCRIPTION });
  const published = await f.api.publishEvidence(f.args);
  assert.equal(published.descriptionCleaned, 2);
  const edits = ghCalls(f, 'pr', 'edit');
  assert.equal(edits.length, 1);
  const written = readFileSync(edits[0][edits[0].indexOf('--body-file') + 1], 'utf8');
  assert.ok(written.includes('https://pr/1#issuecomment-900') && !written.includes('## Screenshots'));
  const clean = fixture(t, { prBody: '## Summary\nBuilt the filter.\n' });
  assert.equal((await clean.api.publishEvidence(clean.args)).descriptionCleaned, 0);
  assert.equal(ghCalls(clean, 'pr', 'edit').length, 0);
});

test('prompts that write on the PR keep proof out of the description', () => {
  assert.match(headless.EVIDENCE_PROMPT({ helper: 'h', ticketUrl: 't', prUrl: 'p', worktree: 'w' }), /description never repeats it/);
  assert.match(headless.EVIDENCE_REFRESH_PROMPT({ helper: 'h', prUrl: 'p', pr: 1 }), /description never repeats it/);
});
