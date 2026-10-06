import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliSummary, cliUpdateNeeded, cliVersionFrom, compareVersions, isNewer, latestRelease, meetsRequirement, registryTarget, updateWouldHelp } from '../src/shared/cliUpdates.ts';

const TOO_OLD = "Claude Code returned an error result: API Error: 400 Claude Code 2.1.273 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";

test('the API refusing a model for the CLI version names both versions, and only that error asks for a download', () => {
  assert.deepEqual(cliUpdateNeeded(TOO_OLD, 'claude'), { provider: 'claude', current: '2.1.273', required: '2.1.280', reason: 'Claude Code 2.1.273 is too old for this model; 2.1.280 or newer is required.' });
  assert.equal(cliUpdateNeeded("Please run 'claude update' to continue", 'claude')?.required, undefined);
  assert.ok(cliUpdateNeeded("Please run 'claude update' to continue", 'claude'));
  for (const benign of ['No conversation found with session ID abc', 'API Error: 401 invalid x-api-key', 'context window exceeded', 'The model claude-opus-5 is not available on your plan'])
    assert.equal(cliUpdateNeeded(benign, 'claude'), undefined, benign);
  assert.equal(cliUpdateNeeded(undefined, 'claude'), undefined);
  // the same Claude wording on a Codex chat is not Codex's problem
  assert.equal(cliUpdateNeeded(TOO_OLD, 'codex'), undefined);
  assert.ok(cliUpdateNeeded('unsupported model: gpt-6.1-sol', 'codex'));
  assert.ok(cliUpdateNeeded('Codex CLI is out of date, please upgrade', 'codex'));
  assert.equal(cliUpdateNeeded('stream disconnected before completion', 'codex'), undefined);
});

test('versions compare numerically, whatever suffix or prose surrounds them', () => {
  assert.equal(compareVersions('0.3.281', '0.3.273'), 1);
  assert.equal(compareVersions('0.160.0-darwin-arm64', '0.159.0'), 1);
  assert.equal(compareVersions('2.1.9', '2.1.10'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(isNewer('0.3.281', undefined), 'anything beats nothing');
  assert.ok(!isNewer(undefined, '0.3.281'));
  assert.equal(cliVersionFrom('2.1.280 (Claude Code)'), '2.1.280');
  assert.equal(cliVersionFrom('codex-cli 0.160.0\n'), '0.160.0');
  assert.equal(cliVersionFrom(''), undefined);
});

test("a download is worth it only when the registry is newer than what runs and reaches the version the error asked for", () => {
  const need = cliUpdateNeeded(TOO_OLD, 'claude');
  // the agent SDK package is 0.3.N for Claude Code 2.1.N, so the patch number is the release
  assert.equal(updateWouldHelp(need, '0.3.273', '0.3.281'), true);
  assert.equal(updateWouldHelp(need, '0.3.273', '0.3.279'), false, 'newer but still too old');
  assert.equal(updateWouldHelp(need, '0.3.281', '0.3.281'), false, 'already there: the failure is something else');
  assert.equal(updateWouldHelp(need, '0.3.273', undefined), false);
  assert.equal(updateWouldHelp({ provider: 'codex', reason: 'x' }, '0.159.0', '0.160.0'), true);
  assert.equal(updateWouldHelp({ provider: 'codex', reason: 'x', required: '0.161.0' }, '0.159.0', '0.160.0'), false);
  assert.equal(meetsRequirement('claude', '0.3.280', '2.1.280'), true);
  assert.equal(meetsRequirement('codex', '0.160.0', '0.160.0'), true);
});

test('each provider publishes its binary differently on npm: Claude Code one package per platform, Codex one package with platform-suffixed versions', () => {
  const claude = registryTarget('claude', 'darwin', 'arm64');
  assert.equal(claude.metadataUrl, 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64');
  assert.equal(claude.versionKey('0.3.281'), '0.3.281');
  assert.equal(claude.binary, 'package/claude');
  const codex = registryTarget('codex', 'darwin', 'arm64');
  assert.equal(codex.metadataUrl, 'https://registry.npmjs.org/@openai/codex');
  assert.equal(codex.versionKey('0.160.0'), '0.160.0-darwin-arm64');
  assert.equal(codex.binary, 'package/vendor/aarch64-apple-darwin/bin/codex');
  assert.equal(registryTarget('codex', 'linux', 'x64').binary, 'package/vendor/x86_64-unknown-linux-musl/bin/codex');
  assert.throws(() => registryTarget('codex', 'sunos', 'x64'), /no build/);
});

test('the latest release is read from the packument for this machine, with its tarball and checksum', () => {
  const packument = { 'dist-tags': { latest: '0.160.0' }, versions: {
    '0.160.0': { dist: { tarball: 'https://r/codex-0.160.0.tgz' } },
    '0.160.0-darwin-arm64': { dist: { tarball: 'https://r/codex-0.160.0-darwin-arm64.tgz', integrity: 'sha512-abc' } },
  } };
  assert.deepEqual(latestRelease(packument, registryTarget('codex', 'darwin', 'arm64')), { version: '0.160.0', tarball: 'https://r/codex-0.160.0-darwin-arm64.tgz', integrity: 'sha512-abc' });
  assert.equal(latestRelease(packument, registryTarget('codex', 'linux', 'x64')), undefined, 'no build for that platform yet');
  assert.equal(latestRelease({ versions: {} }, registryTarget('claude', 'darwin', 'arm64')), undefined);
  assert.equal(latestRelease(null, registryTarget('claude', 'darwin', 'arm64')), undefined);
});

test('the settings line says what runs, where it came from, and whether the registry has more', () => {
  assert.equal(cliSummary({ provider: 'claude', version: '2.1.273', source: 'bundled', npmVersion: '0.3.273', bundled: '2.1.273' }), 'Claude Code 2.1.273 (bundled)');
  assert.equal(cliSummary({ provider: 'claude', version: '2.1.273', source: 'bundled', npmVersion: '0.3.273', bundled: '2.1.273', latest: '0.3.281' }), 'Claude Code 2.1.273 (bundled) · update available');
  assert.equal(cliSummary({ provider: 'codex', version: '0.160.0', source: 'downloaded', npmVersion: '0.160.0', bundled: '0.159.0', latest: '0.160.0' }), 'Codex 0.160.0 (downloaded)');
  assert.equal(cliSummary({ provider: 'codex', source: 'missing' }), 'Codex not found');
});
