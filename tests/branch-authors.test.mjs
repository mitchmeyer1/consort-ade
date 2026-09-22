import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { branchAuthors } from '../src/main/git.ts';
import { topContributor } from '../src/shared/contributors.ts';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const as = (name) => ({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name.toLowerCase().replace(/\s/g, '.')}@example.invalid`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name.toLowerCase()}@example.invalid` });
let n = 0;
async function commit(cwd, author, msg) {
  await writeFile(join(cwd, `f${++n}.txt`), msg);
  git(cwd, 'add', '.');
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd, env: { ...process.env, ...as(author), GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'ignore' });
}

/** a remote whose default branch is an old feature branch, a long-lived development branch by Peter, and Mitch's branch cut from development */
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'consort-authors-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const origin = join(dir, 'origin.git'), repo = join(dir, 'repo');
  git(dir, 'init', '-q', '--bare', origin);
  git(dir, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'commit.gpgsign', 'false');
  await commit(repo, 'Peter Monaco', 'initial');
  git(repo, 'branch', 'posthog-integration');          // the stale "default branch" GitHub reports
  git(repo, 'checkout', '-q', '-b', 'development');
  for (let i = 0; i < 5; i++) await commit(repo, 'Peter Monaco', `dev ${i}`);
  git(repo, 'checkout', '-q', '-b', 'mm/ghissue-265');
  await commit(repo, 'Mitch Meyer', 'fix the issue');
  await commit(repo, 'Mitch Meyer', 'and a test');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main', 'posthog-integration', 'development', 'mm/ghissue-265');
  return { repo };
}

test('a branch is credited only with its own commits, even when the project base is wrong', async (t) => {
  const { repo } = await fixture(t);
  const commits = await branchAuthors(repo, 'origin/posthog-integration');
  assert.deepEqual([...new Set(commits.map((c) => c.name))], ['Mitch Meyer']);
  assert.equal(commits.length, 2);
  assert.equal(topContributor(commits).name, 'Mitch Meyer');
});

test('a branch already merged into another remote branch has nothing of its own to credit', async (t) => {
  const { repo } = await fixture(t);
  git(repo, 'checkout', '-q', 'development');
  git(repo, 'merge', '-q', '--ff-only', 'mm/ghissue-265');
  git(repo, 'push', '-q', 'origin', 'development');
  git(repo, 'checkout', '-q', 'mm/ghissue-265');
  assert.deepEqual(await branchAuthors(repo, 'origin/posthog-integration'), []);
});

test('with no remote branches to compare against, the base ref decides', async (t) => {
  const { repo } = await fixture(t);
  git(repo, 'remote', 'remove', 'origin');
  const commits = await branchAuthors(repo, 'development');
  assert.deepEqual(commits.map((c) => c.name), ['Mitch Meyer', 'Mitch Meyer']);
  assert.equal((await branchAuthors(repo, 'main')).length, 7);
});
