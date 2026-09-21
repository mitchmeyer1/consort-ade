import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { canCreatePr, parsePrSuggestion, prBaseBranch, prBlockedBy, prCreateArgs, prSuggestionPrompt, prUrlIn, suggestedPrTitle } from '../src/shared/createPr.ts';
import { branchDiffForSummary, createPr } from '../src/main/git.ts';

const status = (over = {}) => ({ branch: 'feature', dirty: 0, ahead: 0, behind: 0, merged: false, inBase: false, base: 'origin/main', files: '', ...over });

test('prBaseBranch strips the origin prefix the project stores', () => {
  assert.equal(prBaseBranch('origin/main'), 'main');
  assert.equal(prBaseBranch('origin/release/2.0'), 'release/2.0');
  assert.equal(prBaseBranch('main'), 'main');
});

test('canCreatePr: a real branch with no PR, never the base itself or a detached head', () => {
  assert.equal(canCreatePr(status()), true);
  assert.equal(canCreatePr(null), false);
  assert.equal(canCreatePr(status({ pr: { number: 4, state: 'OPEN' } })), false);
  assert.equal(canCreatePr(status({ pr: { number: 4, state: 'MERGED' } })), false, 'a merged PR is still the branch\'s PR');
  assert.equal(canCreatePr(status({ branch: 'main' })), false);
  assert.equal(canCreatePr(status({ branch: '(detached)' })), false);
  assert.equal(canCreatePr(status({ branch: '?' })), false);
});

test('prBlockedBy: HEAD already in base has nothing to compare; unpushed or dirty work is fine', () => {
  assert.match(prBlockedBy(status({ inBase: true })), /no commits/);
  assert.equal(prBlockedBy(status({ ahead: 3, dirty: 2 })), undefined);
});

test('suggestedPrTitle prefers the last commit subject, else a readable branch name', () => {
  assert.equal(suggestedPrTitle(status({ last: { subject: 'Add Create PR button', author: 'm', age: 'now' } })), 'Add Create PR button');
  assert.equal(suggestedPrTitle(status({ branch: 'issue/42-fix_login-flow' })), '42 fix login flow');
  assert.equal(suggestedPrTitle(status({ branch: 'feature' })), 'Feature');
});

test('prCreateArgs names head and bare base explicitly and only adds --draft when asked', () => {
  assert.deepEqual(prCreateArgs({ title: ' Title ', body: 'Body\n', base: 'origin/main', head: 'feature', draft: false }),
    ['pr', 'create', '--title', 'Title', '--body', 'Body', '--base', 'main', '--head', 'feature']);
  assert.ok(prCreateArgs({ title: 'T', body: '', base: 'main', head: 'f', draft: true }).includes('--draft'));
  assert.throws(() => prCreateArgs({ title: '  ', body: '', base: 'main', head: 'f', draft: false }), /title/);
});

test('prUrlIn finds the PR link among gh chatter', () => {
  assert.equal(prUrlIn('Creating pull request for feature into main in o/r\n\nhttps://github.com/o/r/pull/12\n'), 'https://github.com/o/r/pull/12');
  assert.equal(prUrlIn('a pull request for branch "feature" into branch "main" already exists:\nhttps://github.com/o/r/pull/7'), 'https://github.com/o/r/pull/7');
  assert.equal(prUrlIn('nothing here'), undefined);
});

test('prSuggestionPrompt names the bare base and carries commits, stat and diff', () => {
  const p = prSuggestionPrompt({ branch: 'feature', base: 'origin/development', commits: '- Add button\n- Fix test', stat: ' a.ts | 2 +-', patch: '@@ -1 +1 @@' });
  assert.match(p, /branch feature against development\./);
  assert.match(p, /2 to 6 bullets/);
  assert.match(p, /Commits:\n- Add button\n- Fix test\n/);
  assert.match(p, /Files changed:\na\.ts \| 2 \+-\n/);
  assert.ok(p.endsWith('Diff:\n@@ -1 +1 @@'));
  assert.match(prSuggestionPrompt({ branch: 'f', base: 'main', commits: '', stat: '', patch: '' }), /\(none listed\)/);
});

test('parsePrSuggestion splits title from bullets and strips model decoration', () => {
  assert.deepEqual(parsePrSuggestion('Add a Create PR button\n\n- Button appears when the branch has no PR.\n- Dialog pushes then calls gh.\n'),
    { title: 'Add a Create PR button', body: '- Button appears when the branch has no PR.\n- Dialog pushes then calls gh.' });
  assert.deepEqual(parsePrSuggestion('# **Title: Fix login loop.**\n\n* First point\n• Second point'), { title: 'Fix login loop', body: '- First point\n- Second point' });
  assert.deepEqual(parsePrSuggestion('\n\nJust a title\n'), { title: 'Just a title', body: '' });
  assert.deepEqual(parsePrSuggestion('   '), { title: '', body: '' });
});

// --- the main-process step, against a real repo, a bare origin, and a stand-in gh ---
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t, { remote = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'consort-create-pr-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'root'), source = join(dir, 'source'), origin = join(dir, 'remote.git');
  git(dir, 'init', '-b', 'main', root);
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'code.txt'), 'original');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'initial');
  git(root, 'worktree', 'add', '-b', 'feature', source);
  await writeFile(join(source, 'code.txt'), 'changed');
  git(source, 'add', '.'); git(source, 'commit', '-m', 'Change the code');
  if (remote) {
    git(root, 'init', '--bare', origin);
    git(root, 'remote', 'add', 'origin', origin);
    git(root, 'push', 'origin', 'main');
  }
  // a gh that records its argv and answers like the real one
  const bin = join(dir, 'bin'), log = join(dir, 'gh.log');
  execFileSync('mkdir', ['-p', bin]);
  await writeFile(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\necho "Creating pull request for feature into main in o/r" >&2\necho "https://github.com/o/r/pull/12"\n`);
  await chmod(join(bin, 'gh'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = bin + delimiter + path;
  t.after(() => { process.env.PATH = path; });
  return { root, source, origin, log };
}

test('createPr pushes the branch with an upstream, then calls gh with head and base, and returns the URL', async (t) => {
  const { source, origin, log } = await fixture(t);
  const result = await createPr(source, 'feature', 'origin/main', { title: 'Change the code', body: 'Why', draft: true });
  assert.deepEqual(result, { url: 'https://github.com/o/r/pull/12', number: 12 });
  assert.equal(git(origin, 'rev-parse', 'feature'), git(source, 'rev-parse', 'HEAD'), 'the branch reached origin before gh ran');
  assert.equal(git(source, 'rev-parse', '--abbrev-ref', 'feature@{upstream}'), 'origin/feature');
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'),
    ['pr', 'create', '--title', 'Change the code', '--body', 'Why', '--base', 'main', '--head', 'feature', '--draft']);
});

test('createPr refuses a stale branch and a failed push before touching gh', async (t) => {
  const { source, log } = await fixture(t, { remote: false });
  await assert.rejects(createPr(source, 'main', 'origin/main', { title: 'T', body: '', draft: false }), /branch changed/);
  await assert.rejects(createPr(source, 'feature', 'origin/main', { title: 'T', body: '', draft: false }), /Push failed, so no PR was opened/);
  await assert.rejects(readFile(log, 'utf8'), 'gh never ran');
  await assert.rejects(createPr(source, 'feature', 'origin/main', { title: '', body: '', draft: false }), /title/);
});

test('branchDiffForSummary lists only the branch\'s commits and diff from the merge base', async (t) => {
  const { root, source } = await fixture(t, { remote: false });
  // main moves on after the branch was cut: that change must not read as the branch's work
  await writeFile(join(root, 'main-only.txt'), 'base moved');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'Base moved on');
  await writeFile(join(source, 'code.txt'), 'changed; uncommitted edit');
  const out = await branchDiffForSummary(source, 'feature', 'main');
  assert.deepEqual(out, { ...out, branch: 'feature', base: 'main', commits: '- Change the code\n' });
  assert.match(out.stat, /code\.txt/);
  assert.doesNotMatch(out.stat, /main-only/);
  assert.match(out.patch, /\+changed$/m);
  assert.doesNotMatch(out.patch, /uncommitted edit/, 'working tree changes are not part of the PR');
});
