// Fixtures come from ./helpers/fake-pii.mjs at run time: no identifier shape is written here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryLine, HIGH_PRECISION, luhn, maskShape, piiSpans, redactSpans, scanPii, shapeLine } from '../src/shared/piiGate.ts';
import * as fake from './helpers/fake-pii.mjs';

const value = (s) => s.replace(/^[^:]*:\s*/, '');

test('each block detector finds its identifier and reports a masked shape, never the value', () => {
  const cases = [
    ['ssn', fake.ssn()], ['card', fake.card()], ['mbi', fake.mbi()], ['phone', fake.phone()], ['phone-anchored', fake.e164()],
    ['email', fake.email()], ['mrn', `${fake.label('M', 'RN')}: ${fake.digits(7)}`], ['dob', `${fake.label('D', 'OB')}: ${fake.date()}`], ['address', fake.address()],
  ];
  for (const [category, text] of cases) {
    const scan = scanPii(`Report line: ${text} and more`, 'release');
    assert.equal(scan.clean, false, `${category} blocks`);
    const found = scan.findings.find((f) => f.category === category);
    assert.ok(found, `${category} found`);
    assert.equal(found.tier, 'block');
    assert.ok(!JSON.stringify(scan).includes(value(text)), `${category}: the report never carries the value`);
    assert.doesNotMatch(found.shape, /[0-9]/);
  }
});

test('the release posture exempts nothing; the commit posture lets published placeholders and documentation addresses through', () => {
  const placeholders = [fake.placeholderSsn(), fake.publishedTestCard(), fake.fictionalPhone(), ['dev', 'example.com'].join('@'), ['noreply', 'vendor.io'].join('@')];
  for (const text of placeholders) {
    assert.equal(scanPii(`fixture: ${text}`, 'release').clean, false, `release blocks ${maskShape(text)}`);
    assert.equal(scanPii(`fixture: ${text}`, 'commit').clean, true, `commit lets ${maskShape(text)} through`);
  }
  assert.equal(scanPii(fake.ssn(), 'commit').clean, false, 'a real-looking value still blocks at commit time');
});

test('colleagues\' mail, toll-free lines and published numbers are never findings', () => {
  const ours = ['someone', 'alignedmarketplace.com'].join('@');
  const tollFree = ['800', '555', '1234'].join('-');
  const published = [fake.digits(0) + '312', '555', '7788'].join('-');
  assert.equal(scanPii(`ask ${ours} or call ${tollFree}`, 'release').clean, true);
  assert.equal(scanPii(`call ${published}`, 'release', { publishedPhones: [published] }).clean, true);
  assert.equal(scanPii(`mail ${ours}`, 'release', { internalEmailDomains: ['other.org'] }).clean, false, 'the allowlist is configurable');
});

test('Luhn and the issuer table keep control numbers out of the card detector', () => {
  const body = ['1', fake.digits(14)].join('');
  const noIssuer = body + String([...Array(10).keys()].find((d) => luhn(body + d)));
  assert.ok(luhn(noIssuer));
  assert.equal(scanPii(noIssuer, 'release').findings.some((f) => f.category === 'card'), false, 'Luhn-valid but no issuer');
  const card = fake.card();
  const broken = card.slice(0, -1) + String((Number(card.at(-1)) + 1) % 10);
  assert.equal(scanPii(broken, 'release').findings.some((f) => f.category === 'card'), false, 'right issuer, wrong check digit');
});

test('pasted rows are a warning, not a block; a Markdown table of aggregates is neither', () => {
  const rows = ['plan,members,share,month', 'gold,120,0.4,2026-09', 'silver,98,0.3,2026-09'].join('\n');
  const scan = scanPii(rows, 'release');
  assert.equal(scan.clean, true);
  assert.deepEqual(scan.findings.map((f) => [f.category, f.tier]), [['rows', 'warn']]);
  assert.equal(scanPii(['| plan | members | share | month |', '| gold | 120 | 0.4 | 2026-09 |', '| silver | 98 | 0.3 | 2026-09 |'].join('\n'), 'release').findings.length, 0);
});

test('redaction replaces block spans, merges overlaps and leaves the rest; shapes are capped and lines name categories only', () => {
  const ssn = fake.ssn(), mail = fake.email();
  const text = `first ${ssn} then ${mail} done`;
  assert.equal(redactSpans(text, piiSpans(text, 'release')), 'first [REDACTED:ssn] then [REDACTED:email] done');
  assert.equal(maskShape('x'.repeat(50)).length, 41);
  assert.equal(maskShape('Ab 12-x'), 'AA_NN-A');
  const scan = scanPii(text, 'release');
  assert.equal(categoryLine(scan), 'ssn ×1, email ×1');
  assert.doesNotMatch(shapeLine(scan), /[0-9]/);
});

test('high precision is the checksum, positional and labelled detectors only', () => {
  assert.deepEqual([...HIGH_PRECISION].sort(), ['card', 'dob', 'mbi', 'mrn', 'phone-anchored', 'ssn']);
  assert.equal(scanPii(`call ${fake.phone()}`, 'release').highPrecision, false);
  assert.equal(scanPii(`id ${fake.ssn()}`, 'release').highPrecision, true);
});
