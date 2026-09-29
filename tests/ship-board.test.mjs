import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as ship from '../src/shared/ship.ts';
const { fillShipCommand, isSlashCommand, nextCommand, parseShipState, shipActionOf, shipActions, sortShip } = ship;

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('../src/main/ship.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const main = { exports: {} };
new Function('require', 'module', 'exports', compiled)(name => (name === '../shared/ship' ? ship : require(name)), main, main.exports);

const state = (over = {}) => ({
  slug: 'lead-intake-sms', title: 'Lead intake keyword SMS', clickup_task_id: '86akk4nnj', clickup_url: 'https://app.clickup.com/t/86akk4nnj',
  stage: 'Ready to Test', built: true, repos: ['aligned-mono'], prs: ['https://github.com/org/aligned-mono/pull/488'],
  next_step: '/ship 86akk4nnj approve (after Peter tries the stories)', last_transition: '2026-09-23T15:00:00Z',
  history: [{ comment: 'round 1' }, { comment: 'round 2: 7/8 stories pass' }],
  report: { html: '/Users/x/command-center/pipeline/lead-intake-sms/report.html', summary: { 1: { status: 'PASS', title: 'a' }, 2: { status: 'FAIL', title: 'b' }, 3: { status: 'PASS', title: 'c' } } },
  ...over,
});

test('a state.json becomes a board card; one without a slug or stage is skipped', () => {
  const f = parseShipState(state(), '/p/lead-intake-sms', true);
  assert.equal(f.ticket, '86akk4nnj');
  assert.equal(f.stage, 'Ready to Test');
  assert.equal(f.built, true);
  assert.equal(f.lastNote, 'round 2: 7/8 stories pass');
  assert.equal(f.lastTransition, Date.parse('2026-09-23T15:00:00Z'));
  assert.equal(f.report, '/Users/x/command-center/pipeline/lead-intake-sms/report.html');
  assert.deepEqual(f.tests, { pass: 2, total: 3 });
  assert.equal(f.polling, true);
  assert.equal(parseShipState(state({ report: undefined }), '/p').tests, undefined);
  assert.equal(parseShipState({ stage: 'Spec\'d' }, '/p'), undefined);
  assert.equal(parseShipState(null, '/p'), undefined);
});

test('the board runs active stages in pipeline order, paused after them and finished last', () => {
  const at = (stage, t, paused = false) => parseShipState(state({ slug: `${stage}-${t}`, stage, paused, last_transition: `2026-09-2${t}T00:00:00Z` }), '/p');
  const order = sortShip([at('Merged', 5), at('In Review', 1), at('Implementing', 2, true), at('Grilling', 1), at('In Review', 3)]).map((f) => f.slug);
  assert.deepEqual(order, ['Grilling-1', 'In Review-3', 'In Review-1', 'Implementing-2', 'Merged-5']);
});

test('the next step\'s command drops the skill\'s remark', () => {
  const f = (next) => parseShipState(state({ next_step: next }), '/p');
  assert.equal(nextCommand(f('/ship 86akk4nnj approve (after Peter tries the stories)')), '/ship 86akk4nnj approve');
  assert.equal(nextCommand(f('/ship 86akk4nnj pr-loop')), '/ship 86akk4nnj pr-loop');
  assert.equal(nextCommand(f('Waiting on Mitch')), undefined);
});

test('each stage gets its buttons, with the skill\'s next step first', () => {
  const ids = (over) => shipActions(parseShipState(state(over), '/p')).map((a) => a.id);
  assert.deepEqual(ids({}), ['next', 'approve', 'feedback', 'pause']);
  assert.deepEqual(ids({ stage: 'In Review', next_step: 'Waiting on review' }), ['next', 'pr-loop', 'feedback', 'pause']);
  assert.deepEqual(ids({ stage: 'In Review', next_step: '/ship 86akk4nnj pr-loop' }), ['next', 'feedback', 'pause']);
  assert.deepEqual(ids({ paused: true }), ['resume']);
  assert.deepEqual(ids({ stage: 'Merged' }), []);
  const [next] = shipActions(parseShipState(state(), '/p'));
  assert.equal(next.command, '/ship 86akk4nnj approve');
  assert.equal(shipActions(parseShipState(state({ clickup_task_id: undefined, next_step: undefined }), '/p'))[0].command, '/ship lead-intake-sms');
});

test('feedback is quoted the way the skill reads it', () => {
  assert.equal(fillShipCommand('/ship 86akk4nnj {text}', '  the "Stop" reply should also opt out \\ unsubscribe '), '/ship 86akk4nnj "the \\"Stop\\" reply should also opt out \\\\ unsubscribe"');
});

test('a /ship command names its chat by what it asks for', () => {
  assert.equal(shipActionOf('/ship new keyword SMS for leads'), 'new');
  assert.equal(shipActionOf('/ship pause 86akk4nnj'), 'pause');
  assert.equal(shipActionOf('/ship 86akk4nnj approve'), 'approve');
  assert.equal(shipActionOf('/ship 86akk4nnj pr-loop'), 'pr-loop');
  assert.equal(shipActionOf('/ship 86akk4nnj "fix the copy"'), 'feedback');
  assert.equal(shipActionOf('/ship 86akk4nnj'), 'next');
});

test('only a message that starts with a command is sent as a slash command', () => {
  assert.equal(isSlashCommand('/ship 86akk4nnj approve'), true);
  assert.equal(isSlashCommand('  /ship'), true);
  assert.equal(isSlashCommand('/plugin:skill-name arg'), true);
  assert.equal(isSlashCommand('please run /ship'), false);
  assert.equal(isSlashCommand('/Users/x/file.md is broken'), false);
});

test('the board reads every feature folder and skips the skill\'s archive and scratch', () => {
  const root = mkdtempSync(join(tmpdir(), 'ship-board-'));
  try {
    const put = (name, body) => { mkdirSync(join(root, name)); writeFileSync(join(root, name, 'state.json'), typeof body === 'string' ? body : JSON.stringify(body)); };
    put('lead-intake-sms', state());
    put('v4-demo', state({ slug: 'v4-demo', stage: 'Implementing' }));
    put('_archive', state({ slug: 'old' }));
    put('.scratch', state({ slug: 'tmp' }));
    put('broken', '{not json');
    writeFileSync(join(root, 'v4-demo', 'await-review.pid'), String(process.pid));
    const board = main.exports.readShipBoard(root);
    assert.equal(board.error, undefined);
    assert.deepEqual(board.features.map((f) => f.slug), ['v4-demo', 'lead-intake-sms']);
    assert.equal(board.features[0].polling, true);
    assert.equal(board.features[1].polling, false);
    assert.match(main.exports.readShipBoard(join(root, 'missing')).error, /No \/ship pipeline/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
