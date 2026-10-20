import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as sharedCli from '../src/shared/cliUpdates.ts';

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('../src/main/cliRuntime.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/import\.meta\.url/g, '"file:///tests/cli-runtime"'); // the module is ESM in the app; this harness evaluates CommonJS

/** a fresh module each time: its caches (registry checks, versions, in-flight updates) start empty */
function load() {
  const mocks = { electron: { app: { getPath: () => { throw new Error('not in tests'); }, getAppPath: () => { throw new Error('not in tests'); } } }, '../shared/cliUpdates': sharedCli };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => mocks[name] ?? require(name), mod, mod.exports);
  return mod.exports;
}

/** an app dir with a bundled Claude Code 0.3.273 and Codex 0.159.0, and an empty userData */
function world({ bundledClaude = '0.3.273', bundledCodex = '0.159.0' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'cli-runtime-'));
  const appPath = join(base, 'app');
  const claudeDir = join(appPath, 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64');
  const codexDir = join(appPath, 'node_modules/@openai/codex-darwin-arm64');
  mkdirSync(claudeDir, { recursive: true }); mkdirSync(join(codexDir, 'vendor/aarch64-apple-darwin/bin'), { recursive: true });
  writeFileSync(join(claudeDir, 'package.json'), JSON.stringify({ version: bundledClaude }));
  writeFileSync(join(claudeDir, 'claude'), `#!/bin/sh\necho 2.1.${bundledClaude.split('.')[2]} (Claude Code)`);
  writeFileSync(join(codexDir, 'package.json'), JSON.stringify({ version: `${bundledCodex}-darwin-arm64` }));
  writeFileSync(join(codexDir, 'vendor/aarch64-apple-darwin/bin/codex'), `#!/bin/sh\necho codex-cli ${bundledCodex}`);
  return { appPath, root: join(base, 'userData/cli'), claudeDir, codexDir };
}

const tarballBytes = Buffer.from('not really a tarball, tar is faked');
const integrity = `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`;

/** a registry serving one Claude Code and one Codex release, a tarball each, and a tar that "unpacks" the binary named by the version */
function registry({ claude = '0.3.281', codex = '0.160.0', badChecksum = false } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), accept: new Headers(init.headers ?? {}).get('accept') });
    const u = String(url);
    if (u.endsWith('claude-agent-sdk-darwin-arm64')) return Response.json({ 'dist-tags': { latest: claude }, versions: { [claude]: { dist: { tarball: `https://r/claude-${claude}.tgz`, integrity: badChecksum ? 'sha512-wrong' : integrity } } } });
    if (u.endsWith('@openai/codex')) return Response.json({ 'dist-tags': { latest: codex }, versions: { [`${codex}-darwin-arm64`]: { dist: { tarball: `https://r/codex-${codex}.tgz`, integrity } } } });
    if (u.endsWith('.tgz')) return new Response(tarballBytes, { status: 200 });
    return new Response('nope', { status: 404 });
  };
  const exec = async (cmd, args) => {
    if (cmd === 'tar') {
      const dir = args[args.indexOf('-C') + 1];
      const tgz = args[args.indexOf('-xzf') + 1];
      assert.ok(existsSync(tgz), 'tar reads the downloaded file');
      const version = /(\d+\.\d+\.\d+)\.tgz$/.exec(tgz)[1];
      const rel = tgz.includes('/claude/') ? 'package/claude' : 'package/vendor/aarch64-apple-darwin/bin/codex';
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), tgz.includes('/claude/') ? `#!/bin/sh\necho 2.1.${version.split('.')[2]} (Claude Code)` : `#!/bin/sh\necho codex-cli ${version}`);
      return '';
    }
    if (args[0] === '--version') return readFileSync(cmd, 'utf8').split('\n')[1].replace(/^echo /, '');
    throw new Error(`unexpected exec ${cmd} ${args.join(' ')}`);
  };
  return { fetch, exec, calls };
}

const depsFor = (w, r, now = { t: 1_000_000 }) => ({ root: () => w.root, appPath: () => w.appPath, fetch: r.fetch, exec: r.exec, platform: 'darwin', arch: 'arm64', now: () => now.t });

test('with nothing downloaded the bundled binaries run, and status says so', async () => {
  const { cliBinary, cliStatus } = load();
  const w = world(); const deps = depsFor(w, registry());
  assert.equal(cliBinary('claude', deps), join(w.claudeDir, 'claude'));
  assert.equal(cliBinary('codex', deps), join(w.codexDir, 'vendor/aarch64-apple-darwin/bin/codex'));
  assert.deepEqual(await cliStatus('claude', deps), { provider: 'claude', version: '2.1.273', source: 'bundled', npmVersion: '0.3.273', bundled: '2.1.273' });
});

test('a newer release is fetched from the registry, unpacked, checked, made current, and wins over the bundled binary', async () => {
  const { updateCli, cliBinary, cliStatus } = load();
  const w = world(); const r = registry(); const deps = depsFor(w, r);
  assert.equal(await updateCli('claude', undefined, deps), true);
  const binary = join(w.root, 'claude/0.3.281/package/claude');
  assert.ok(existsSync(binary));
  assert.equal(cliBinary('claude', deps), binary);
  assert.ok(!existsSync(join(w.root, 'claude/0.3.281.tgz')), 'the tarball is not kept');
  assert.equal(r.calls[0].accept, 'application/vnd.npm.install-v1+json', 'the abbreviated packument, not every changelog');
  assert.deepEqual(JSON.parse(readFileSync(join(w.root, 'claude/current.json'), 'utf8')), { npmVersion: '0.3.281', cliVersion: '2.1.281', binary, at: 1_000_000 });
  const status = await cliStatus('claude', deps);
  assert.equal(status.source, 'downloaded');
  assert.equal(status.version, '2.1.281');
  assert.equal(status.bundled, '2.1.273');
  assert.equal(status.latest, '0.3.281');
  assert.equal(status.note, 'Claude Code 2.1.281 downloaded.');
  // Codex too, from its platform-suffixed version
  assert.equal(await updateCli('codex', undefined, deps), true);
  assert.equal(cliBinary('codex', deps), join(w.root, 'codex/0.160.0/package/vendor/aarch64-apple-darwin/bin/codex'));
});

test('nothing is fetched when the registry has nothing newer, and a download that cannot satisfy the error is not attempted', async () => {
  const { updateCli, cliStatus } = load();
  const w = world({ bundledClaude: '0.3.281' }); const r = registry(); const deps = depsFor(w, r);
  assert.equal(await updateCli('claude', undefined, deps), false);
  assert.equal(r.calls.filter((c) => c.url.endsWith('.tgz')).length, 0);
  assert.equal((await cliStatus('claude', deps)).note, 'Claude Code is up to date.');
  const old = world(); const r2 = registry({ claude: '0.3.279' }); const deps2 = depsFor(old, r2);
  const need = sharedCli.cliUpdateNeeded('Claude Code 2.1.273 does not support this model; version 2.1.280 or newer is required.', 'claude');
  assert.equal(await updateCli('claude', need, deps2), false);
  assert.equal(r2.calls.filter((c) => c.url.endsWith('.tgz')).length, 0);
  assert.match((await cliStatus('claude', deps2)).note, /0\.3\.279 is newer but still older than the 2\.1\.280/);
});

test('a tarball that does not match the registry checksum is thrown away, and the bundled binary stays in use', async () => {
  const { updateCli, cliBinary, cliStatus } = load();
  const w = world(); const deps = depsFor(w, registry({ badChecksum: true }));
  await assert.rejects(updateCli('claude', undefined, deps), /checksum/);
  assert.equal(cliBinary('claude', deps), join(w.claudeDir, 'claude'));
  assert.match((await cliStatus('claude', deps)).note, /update failed: download did not match/);
});

test('an older download is ignored once a newer Consort bundles more, and a download whose binary vanished is ignored too', async () => {
  const { updateCli, cliBinary } = load();
  const w = world(); const deps = depsFor(w, registry({ claude: '0.3.281' }));
  await updateCli('claude', undefined, deps);
  // a later app build bundles 0.3.290
  writeFileSync(join(w.claudeDir, 'package.json'), JSON.stringify({ version: '0.3.290' }));
  assert.equal(cliBinary('claude', deps), join(w.claudeDir, 'claude'));
  writeFileSync(join(w.claudeDir, 'package.json'), JSON.stringify({ version: '0.3.273' }));
  assert.equal(cliBinary('claude', deps), join(w.root, 'claude/0.3.281/package/claude'));
  const { rmSync } = await import('node:fs');
  rmSync(join(w.root, 'claude/0.3.281'), { recursive: true });
  assert.equal(cliBinary('claude', deps), join(w.claudeDir, 'claude'));
});

test('two chats failing at once share one download, and updating both providers reports whether anything changed', async () => {
  const { updateCli, updateAllClis } = load();
  const w = world(); const r = registry(); const deps = depsFor(w, r);
  const [a, b] = await Promise.all([updateCli('claude', undefined, deps), updateCli('claude', undefined, deps)]);
  assert.deepEqual([a, b], [true, true]);
  assert.equal(r.calls.filter((c) => c.url.endsWith('.tgz')).length, 1);
  assert.equal(await updateAllClis(deps), true, 'Codex was still behind');
  assert.equal(await updateAllClis(deps), false);
});
