import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { listFiles, readFile, writeFile as saveFile } from '../src/main/git.ts';

test('editor lists and edits ignored files throughout the workspace without changing Git status', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'consort-editor-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git('init', '-q');
  await writeFile(join(cwd, '.gitignore'), '.env\n.env.*\nnode_modules/\n.env.directory/\n');
  await writeFile(join(cwd, '.env'), 'EXAMPLE=before\n');
  await writeFile(join(cwd, '.env.local'), 'EXAMPLE=local\n');
  await writeFile(join(cwd, 'app.ts'), 'export {};');
  await mkdir(join(cwd, '.env.directory'));
  await mkdir(join(cwd, 'node_modules'));
  await writeFile(join(cwd, 'node_modules', 'ignored.js'), '');
  git('add', 'app.ts', '.gitignore');
  const files = await listFiles(cwd);
  for (const name of ['.env', '.env.local', '.gitignore', 'app.ts', 'node_modules/ignored.js', '.git/config']) assert.ok(files.includes(name), name);
  assert.ok(!files.includes('.env.directory'));
  assert.deepEqual(files, [...files].sort());
  assert.equal(await readFile(cwd, '.env'), 'EXAMPLE=before\n');
  await saveFile(cwd, '.env', 'EXAMPLE=after\n');
  assert.equal(await readFile(cwd, '.env'), 'EXAMPLE=after\n');
  assert.equal(git('check-ignore', '.env').trim(), '.env');
  assert.ok(!git('ls-files').split('\n').includes('.env'));
  git('add', '-f', '.env.local');
  assert.equal((await listFiles(cwd)).filter(f => f === '.env.local').length, 1);
});

test('filesystem listing works without Git and includes hidden, nested, and generated files', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'consort-editor-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const file of ['.config/settings.json', 'packages/app/.env.local', 'dist/bundle.js', 'untracked.txt']) {
    await mkdir(join(cwd, file, '..'), { recursive: true });
    await writeFile(join(cwd, file), 'example');
  }
  assert.deepEqual(await listFiles(cwd), ['.config/settings.json', 'dist/bundle.js', 'packages/app/.env.local', 'untracked.txt']);
  await saveFile(cwd, 'packages/app/.env.local', 'UPDATED=1');
  assert.equal(await readFile(cwd, 'packages/app/.env.local'), 'UPDATED=1');
  await rm(join(cwd, 'untracked.txt'));
  assert.ok(!(await listFiles(cwd)).includes('untracked.txt'));
});

test('file symlinks appear but directory links do not recurse or escape the workspace', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'consort-editor-'));
  const outside = await mkdtemp(join(tmpdir(), 'consort-editor-outside-'));
  t.after(() => Promise.all([rm(cwd, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(join(cwd, 'real.txt'), 'example');
  await writeFile(join(outside, 'outside.txt'), 'outside');
  await symlink('real.txt', join(cwd, 'linked.txt'));
  await symlink('.', join(cwd, 'loop'));
  await symlink(outside, join(cwd, 'external'));
  assert.deepEqual(await listFiles(cwd), ['linked.txt', 'real.txt']);
});

test('deleted tracked files are excluded from the editor', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'consort-editor-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd });
  await writeFile(join(cwd, 'deleted.txt'), 'example');
  execFileSync('git', ['add', 'deleted.txt'], { cwd });
  await rm(join(cwd, 'deleted.txt'));
  assert.ok(!(await listFiles(cwd)).includes('deleted.txt'));
});
