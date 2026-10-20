import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as headless from '../src/shared/headless.ts';
import * as ship from '../src/shared/ship.ts';
const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL('../src/cli/evidence.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'consort-evidence-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const dir = join(root, headless.EVIDENCE_DIR);
  mkdirSync(dir, { recursive: true });
  const manifest = { status: 'passed', kind: 'frontend', summary: 'Map loads and shows the selected group.', blockers: [], checks: [{ story: 'Show locations on a map', status: 'passed', expected: 'Visible map with locations', observed: 'Map loaded and markers appeared', items: ['Working map'] }], items: [{ title: 'Working map', image: 'map.png' }] };
  const save = () => writeFileSync(join(root, headless.EVIDENCE_MANIFEST), JSON.stringify(manifest));
  save();
  writeFileSync(join(dir, 'map.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jT1sAAAAASUVORK5CYII=', 'base64'));
  const calls = [];
  const mocks = { '../shared/headless.ts': headless, '../shared/ship.ts': ship,
    'node:util': { promisify: () => async (cmd, args) => { calls.push(args); if (options.prFails) throw new Error('PR comment rejected'); return { stdout: '' }; } },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'fetch', code)(n => mocks[n] ?? require(n), mod, mod.exports, async () => { calls.push('upload'); return options.uploadFails ? { ok: false, status: 403, text: async () => 'Upload denied' } : { ok: true, text: async () => JSON.stringify({ url: 'https://image.example/map.png' }) }; });
  const args = { worktree: root, repo: root, ticket: { source: 'clickup', id: '1', title: 'Map', url: 'https://ticket/1' }, pr: 1, prUrl: 'https://pr/1', clickupKey: 'test', source: { comment: async () => { calls.push('ticket'); if (options.ticketFails) throw new Error('Ticket unavailable'); } } };
  return { api: mod.exports, root, dir, manifest, save, args, calls };
}

test('manifest rejects missing checks, failed checks, blockers, and frontend text-only output', () => {
  assert.ok(headless.evidenceProblems(undefined).length);
  const base = { status: 'passed', kind: 'backend', summary: 'A real response', items: [{ title: 'Response', text: '200 OK' }], checks: [{ story: 'API responds', status: 'passed', expected: '200', observed: '200', items: ['Response'] }] };
  assert.deepEqual(headless.evidenceProblems(headless.parseEvidenceManifest(base)), []);
  for (const override of [{ status: 'blocked' }, { checks: [] }, { blockers: ['API KEY REQUIRED'] }, { kind: 'frontend' }, { checks: [{ ...base.checks[0], status: 'failed' }] }, { checks: [{ ...base.checks[0], items: ['missing'] }] }]) {
    assert.ok(headless.evidenceProblems(headless.parseEvidenceManifest({ ...base, ...override })).length);
  }
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
    if (key === 'uploadFails') assert.deepEqual(f.calls, ['upload']);
  });
}

test('working evidence publishes images and both comments', async t => {
  const f = fixture(t);
  const published = await f.api.publishEvidence(f.args);
  assert.deepEqual(published, { items: 1, images: 1, prComment: true, ticketComment: true, hosting: 'clickup' });
  assert.ok(readFileSync(join(f.dir, '.pr-comment.md'), 'utf8').includes('https://image.example/map.png'));
  assert.equal(f.calls.at(-1), 'ticket');
});

test('credential recovery names the root path and requires confirmation without sharing secrets', () => {
  const prompt = headless.EVIDENCE_PROMPT({ helper: '/helper', ticketUrl: 'ticket', prUrl: 'pr', worktree: '/task', repoRoot: '/repo' });
  assert.match(prompt, /\/repo\/\.env/);
  assert.match(prompt, /Only after that confirmation, copy the required named variable/);
  assert.match(prompt, /Never ask for a secret in Slack/);
  assert.match(prompt, /never copy the entire root env file/i);
  assert.match(headless.VERIFY_EVIDENCE_PROMPT, /Read every image using image tools/);
});
