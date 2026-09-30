import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEPLOY_SCAN, PROFILE_TTL_DAYS, deployPrompt, parseDeployProfile, profileBrief, profileStale, runtimeLine } from '../src/shared/deployProfile.ts';
import { CATEGORIES, CATEGORY_LABELS, groupFindings, parseReview, reviewCounts, serializeReview } from '../src/shared/review.ts';

const DAY = 86_400_000;
const raw = {
  version: 1,
  platform: 'SST v3 → AWS Lambda (us-east-1)',
  summary: 'Every backend path is a Lambda behind API Gateway; the frontend is S3 + CloudFront.',
  defaults: { memoryMb: 1024, timeoutSec: 30, diskMb: 512 },
  runtimes: [
    { name: 'member-match worker', kind: 'lambda', ref: 'infra/src/queue.ts:40', memoryMb: 256, timeoutSec: 60, concurrency: 'reserved 5', limits: 'SQS batch of 10' },
    { name: 'nightly sync', kind: 'cron', ref: 'infra/src/cron.ts:12', memory: '1.5 GB', timeout: '900' },
  ],
  sources: ['sst.config.ts', 'infra/src/queue.ts'],
  at: '2026-09-20T15:04:00Z',
  head: 'f37833e3aa',
};

test('a profile survives the round trip, with units normalised to MB', () => {
  const p = parseDeployProfile(raw);
  assert.equal(p.platform, 'SST v3 → AWS Lambda (us-east-1)');
  assert.deepEqual(p.defaults, { memoryMb: 1024, timeoutSec: 30, diskMb: 512 });
  assert.equal(p.runtimes.length, 2);
  assert.equal(p.runtimes[0].memoryMb, 256);
  assert.equal(p.runtimes[1].memoryMb, 1536); // "1.5 GB"
  assert.equal(p.runtimes[1].timeoutSec, 900); // "900"
  assert.equal(p.runtimes[1].kind, 'cron');
});

test('malformed input is dropped, not thrown on', () => {
  assert.equal(parseDeployProfile(undefined), undefined);
  assert.equal(parseDeployProfile({ runtimes: [] }), undefined, 'no platform, no profile');
  const p = parseDeployProfile({ platform: 'Fly.io', runtimes: [{ kind: 'container' }, { name: 'api', kind: 'nonsense' }], sources: [1, 'fly.toml'] });
  assert.equal(p.runtimes.length, 1, 'a runtime with no name is dropped');
  assert.equal(p.runtimes[0].kind, 'other', 'an unknown kind falls back');
  assert.deepEqual(p.sources, ['fly.toml']);
  assert.ok(p.at, 'an undated profile is dated on read');
});

test('a profile goes stale after the TTL, and a missing one is always stale', () => {
  const at = Date.parse(raw.at);
  assert.equal(profileStale(parseDeployProfile(raw), at + 5 * DAY), false);
  assert.equal(profileStale(parseDeployProfile(raw), at + (PROFILE_TTL_DAYS + 1) * DAY), true);
  assert.equal(profileStale(undefined, at), true);
  assert.equal(profileStale(parseDeployProfile({ ...raw, at: 'not a date' }), at), true);
});

test('the brief states every ceiling a scaling claim is measured against', () => {
  const brief = profileBrief(parseDeployProfile(raw));
  assert.match(brief, /SST v3 → AWS Lambda/);
  assert.match(brief, /Stack defaults: 1 GB · 30s timeout · 512 MB disk/);
  assert.match(brief, /member-match worker \(lambda\) — 256 MB · 60s · reserved 5 · SQS batch of 10 — infra\/src\/queue\.ts:40/);
  assert.match(brief, /Deduced from: sst\.config\.ts, infra\/src\/queue\.ts/);
  assert.equal(runtimeLine({ name: 'api', kind: 'server' }), '- api (server) — no limits recorded');
});

test('a fresh profile is handed over; a stale or missing one orders the scan', () => {
  const fresh = parseDeployProfile({ ...raw, at: new Date().toISOString() });
  assert.match(deployPrompt(fresh), /Deployment profile — SST v3/);
  assert.match(deployPrompt(fresh), /Skip the deployment scan/);
  assert.equal(deployPrompt(undefined), DEPLOY_SCAN);
  const old = parseDeployProfile({ ...raw, at: new Date(Date.now() - (PROFILE_TTL_DAYS + 1) * DAY).toISOString() });
  assert.equal(deployPrompt(old), DEPLOY_SCAN, 'a profile past the TTL is re-deduced, not trusted');
  assert.match(DEPLOY_SCAN, /sst\.config\.ts/);
  assert.match(DEPLOY_SCAN, /serverless\.yml/);
});

test('a review carries the profile it was judged against', () => {
  const review = parseReview(JSON.stringify({
    pr: 460, repo: 'o/r', head: 'abc', base: 'def', deploy: raw,
    findings: [{ id: 'SC1', kind: 'item', category: 'scaling', title: 'the export reads every member into memory', file: 'src/export.ts', line: 88, fields: { Limit: '256 MB', Load: '6 GB' }, comment: 'export.ts:88 — …' }],
  }));
  assert.equal(review.deploy.platform, raw.platform);
  assert.equal(review.deploy.runtimes[0].memoryMb, 256);
  assert.equal(JSON.parse(serializeReview(review)).deploy.runtimes[1].memoryMb, 1536);
  const reread = parseReview(serializeReview(review));
  assert.deepEqual(reread.deploy, review.deploy, 'a saved review reloads its profile unchanged');
});

test('Scaling is a review section of its own', () => {
  assert.ok(CATEGORIES.includes('scaling'));
  assert.equal(CATEGORY_LABELS.scaling, 'Scaling');
  const findings = [
    { id: 'SC1', kind: 'item', category: 'scaling', title: 'headroom', status: 'pending' },
    { id: 'D1', kind: 'defect', severity: 'high', category: 'scaling', title: 'out of memory today', status: 'pending' },
  ];
  const { defects, items } = groupFindings(findings);
  const scaling = items.find((g) => g.key === 'scaling');
  assert.equal(scaling.label, 'Scaling');
  assert.deepEqual(scaling.findings.map((f) => f.id), ['SC1'], 'a scaling defect is ranked by severity, not filed as an item');
  assert.deepEqual(defects.find((g) => g.key === 'high').findings.map((f) => f.id), ['D1']);
  const counts = reviewCounts({ findings });
  assert.equal(counts.category.scaling, 1);
  assert.equal(counts.severity.high, 1);
});
