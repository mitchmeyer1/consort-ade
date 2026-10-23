// Fixtures come from ./helpers/fake-pii.mjs at run time: no identifier shape is written here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fake from './helpers/fake-pii.mjs';
import { phiSettings } from '../src/shared/phi.ts';

// the incident log lives under CONSORT_CLI_HOME, fixed when state.ts loads
const home = mkdtempSync(join(tmpdir(), 'consort-phi-gate-'));
process.env.CONSORT_CLI_HOME = home;
const gate = await import('../src/cli/phiGate.ts');
const { PHI_INCIDENTS } = await import('../src/cli/state.ts');
process.on('exit', () => rmSync(home, { recursive: true, force: true }));

const on = phiSettings({ phi: { guard: true, complianceContact: 'the privacy officer' } });
const off = phiSettings({});
const context = (extra = {}) => { const recorded = [], alerts = []; return { recorded, alerts, c: { phi: on, task: 't1', ticket: 'T1', record: (i) => recorded.push(i), alert: (l) => alerts.push(l), ...extra } }; };
const tick = () => new Promise((r) => setImmediate(r));

test('gateText: off or clean lets text through; a finding withholds it and files a shape-only incident', async () => {
  const ssn = fake.ssn();
  assert.deepEqual(gate.gateText('ticket comment', `ssn ${ssn}`, { phi: off }), { ok: true });
  assert.deepEqual(gate.gateText('ticket comment', 'The fix is in.', context().c), { ok: true });
  const { c, recorded, alerts } = context();
  const verdict = gate.gateText('ticket comment', `member ${ssn}`, c);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.categories, 'ssn ×1');
  await tick();
  assert.equal(recorded.length, 1);
  assert.deepEqual({ ...recorded[0], ts: undefined }, { ts: undefined, op: 'ticket comment', task: 't1', ticket: 'T1', categories: 'ssn ×1', shapes: 'ssn:NNN-NN-NNNN' });
  assert.match(alerts[0], /^⚠️ PII gate: ticket comment carried ssn ×1\. Withheld; nothing was sent\. .*Compliance contact: the privacy officer\.$/);
  assert.ok(!JSON.stringify({ verdict, recorded, alerts }).includes(ssn));
});

test('an email is withheld without an incident: not high precision; an internal address passes', async () => {
  const { c, recorded } = context();
  assert.equal(gate.gateText('review', `write to ${fake.email()}`, c).ok, false);
  assert.ok(gate.gateText('review', 'ask ryan.goggin@alignedmarketplace.com', c).ok);
  await tick();
  assert.equal(recorded.length, 0);
});

test('gatedSource withholds a comment, a description or a file before the source sees it', async () => {
  const sent = [];
  const source = { comment: async (id, text) => sent.push(['comment', text]), updateBody: async (id, body) => sent.push(['body', body]), attach: async (id, file) => { sent.push(['attach', file]); return true; }, scan: async () => [] };
  assert.equal(gate.gatedSource(source, { phi: off }), source);
  const gated = gate.gatedSource(source, context().c);
  await gated.comment('T1', 'All green.');
  await assert.rejects(gated.comment('T1', `call ${fake.phone()}`), (e) => e instanceof gate.PiiWithheldError && e.categories === 'phone ×1');
  await assert.rejects(gated.updateBody('T1', `card ${fake.card()}`), gate.PiiWithheldError);
  const dir = mkdtempSync(join(tmpdir(), 'consort-attach-'));
  writeFileSync(join(dir, 'notes.txt'), `mrn: ${fake.digits(8)}`);
  writeFileSync(join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
  writeFileSync(join(dir, 'sheet.xlsx'), Buffer.from([0x50, 0x4b, 0, 0]));
  await assert.rejects(gated.attach('T1', join(dir, 'notes.txt')), gate.PiiWithheldError);
  await assert.rejects(gated.attach('T1', join(dir, 'sheet.xlsx')), /a file the gate cannot read/);
  assert.equal(await gated.attach('T1', join(dir, 'shot.png')), true);
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(sent.map(([kind]) => kind), ['comment', 'attach']);
});

test('inbound masks identifiers and counts them; with the guard off it changes nothing', () => {
  const ssn = fake.ssn(), mbi = fake.mbi();
  const text = `Member ${ssn}, MBI ${mbi}, see the ticket`;
  const masked = gate.inbound(text, on);
  assert.equal(masked.masked, 2);
  assert.equal(masked.text, 'Member [REDACTED:ssn], MBI [REDACTED:mbi], see the ticket');
  assert.deepEqual(gate.inbound(text, off), { text, masked: 0 });
});

test('Slack gets a notice in place of a withheld message, and names masked in a clean one', async () => {
  const { c, recorded } = context();
  assert.equal(gate.slackText(`dob: ${fake.date()}`, c), '⚠️ Message withheld by the PII gate (dob ×1).');
  await tick();
  assert.equal(recorded.length, 1);
  assert.equal(gate.slackText('Will Lerner reviewed it', c), '**** reviewed it');
  assert.equal(gate.slackText('Will Lerner reviewed it', { phi: off }), '**** reviewed it');
});

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'consort-push-gate-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  return { root, git, base, run: async (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }) };
}

test('pushFindings reads every commit: a line added then removed still counts, lockfiles do not, placeholders pass', async () => {
  const { root, git, base, run } = repo();
  const ssn = fake.ssn();
  writeFileSync(join(root, 'a.ts'), `export const a = 1;\nconst fixture = "${ssn}";\n`); git('commit', '-q', '-am', 'add fixture');
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n'); git('commit', '-q', '-am', 'drop fixture');
  writeFileSync(join(root, 'pnpm-lock.yaml'), `integrity: ${fake.ssn()}\n`); git('add', '.'); git('commit', '-q', '-m', `lockfile for ${fake.email()}`);
  writeFileSync(join(root, 'b.ts'), `export const phone = "${fake.fictionalPhone()}"; // ${fake.placeholderSsn()}\n`); git('add', '.'); git('commit', '-q', '-m', 'placeholders');
  const { c, recorded } = context();
  const found = await gate.pushFindings(run, root, [`${base}..HEAD`], c);
  assert.deepEqual(found, ['a.ts:2 ssn ×1', 'commit message: email ×1']);
  await tick();
  assert.equal(recorded[0].op, 'push');
  assert.ok(!JSON.stringify(recorded).includes(ssn));
  assert.deepEqual(await gate.pushFindings(run, root, [`${base}..HEAD`], { phi: off }), []);
  assert.equal(gate.pushGuard(base, { phi: off }), undefined);
  assert.match(await gate.pushGuard(base, c)(run, root), /^Not pushed, by the PII gate: a\.ts:2 ssn ×1, commit message: email ×1\./);
  rmSync(root, { recursive: true, force: true });
});

test('incidents are written one JSON line each, only the owner can read them, and read back newest last', () => {
  gate.incident('push', { categories: 'ssn', shapes: 'ssn:NNN-NN-NNNN' }, { phi: on, task: 't2' });
  gate.incident('Slack message', { categories: 'dob', shapes: 'dob:AAA:_NN/NN/NNNN' }, { phi: on });
  assert.equal(statSync(PHI_INCIDENTS).mode & 0o777, 0o600);
  assert.equal(readFileSync(PHI_INCIDENTS, 'utf8').trim().split('\n').length, 2);
  assert.deepEqual(gate.readIncidents(1).map((i) => i.op), ['Slack message']);
  assert.deepEqual(gate.readIncidents(5).map((i) => i.task), ['t2', undefined]);
});
