import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyShipChange, clickupIdFrom, fillShipCommand, githubIssueFrom, isShipCommand, newShipFeature, parseShipCommand, parseShipMarkers, shipActions, shipBranch, shipBusyLabel, shipStep, shipChatName, shipFooter, shipSlug, stageLabel, stripShipMarkers, withBranchPrefix } from '../src/shared/ship.ts';
import { shipHandler, shipPrompt, shipStageLine, shipStatusSummary, shipTurnHeader } from '../src/shared/shipPrompt.ts';

const ticket = { source: 'github', id: '494', url: 'https://github.com/aligned/mono/issues/494', title: 'HRIS address propagation', repo: 'aligned/mono' };

test('a /ship command parses into its form, with the ref optional inside a ship worktree', () => {
  assert.deepEqual(parseShipCommand('/ship'), { form: 'list' });
  assert.deepEqual(parseShipCommand('/ship new Add a way to export the roster'), { form: 'new', idea: 'Add a way to export the roster' });
  assert.deepEqual(parseShipCommand('/ship approve'), { form: 'approve' });
  assert.deepEqual(parseShipCommand('/ship 494 approve'), { form: 'approve', ref: '494' });
  assert.deepEqual(parseShipCommand('/ship pr-loop'), { form: 'pr-loop' });
  assert.deepEqual(parseShipCommand('/ship pause'), { form: 'pause' });
  assert.deepEqual(parseShipCommand('/ship pause 86akm7a8g'), { form: 'pause', ref: '86akm7a8g' });
  assert.deepEqual(parseShipCommand('/ship "move the button left"'), { form: 'feedback', feedback: 'move the button left' });
  assert.deepEqual(parseShipCommand('/ship 494 "move the button"'), { form: 'feedback', feedback: 'move the button', ref: '494' });
  assert.deepEqual(parseShipCommand('/ship 494'), { form: 'resume', ref: '494' });
  assert.equal(parseShipCommand('/shipping'), undefined);
  assert.equal(isShipCommand('/ship approve'), true);
  assert.equal(isShipCommand('/shipping'), false);
});

test('branch and folder names: a few title words, the ticket id, and the prefix from Settings', () => {
  assert.equal(shipSlug('HRIS address propagation to the roster'), 'hris-address-propagation-roster');
  assert.equal(shipSlug("Fix: the seat chooser's cache"), 'fix-seat-choosers-cache');
  assert.equal(shipSlug('!!!'), 'feature');
  assert.equal(shipBranch('mm', 'hris-address', '494'), 'mm/hris-address-494');
  assert.equal(shipBranch('', 'hris-address', '86AKM7A8G'), 'hris-address-86akm7a8g');
  assert.equal(withBranchPrefix(' /mm/ ', 'issue/12'), 'mm/issue/12');
  assert.equal(withBranchPrefix(undefined, 'issue/12'), 'issue/12');
  assert.equal(stageLabel("Spec'd"), 'ship:specd');
  assert.equal(stageLabel('Ready to Test'), 'ship:ready-to-test');
});

test('markers in a reply become one change, are applied to the feature, and are stripped from the text', () => {
  const text = 'Done.\n[ship-stage: Implementing | Tickets: 4.]\n[ship-pr: https://github.com/aligned/mono/pull/9]\n[ship-next: /ship]\n[ship-built]\nFooter.';
  const change = parseShipMarkers(text);
  assert.deepEqual(change, { stage: 'Implementing', note: 'Tickets: 4.', prs: ['https://github.com/aligned/mono/pull/9'], next: '/ship', built: true });
  const f = newShipFeature(ticket, 'hris-address', 1000);
  const after = applyShipChange(f, change, 2000);
  assert.equal(after.stage, 'Implementing');
  assert.equal(after.built, true);
  assert.deepEqual(after.prs, ['https://github.com/aligned/mono/pull/9']);
  assert.equal(after.history.length, 2);
  assert.equal(after.history[1].note, 'Tickets: 4.');
  assert.equal(f.history.length, 1, 'the input is not mutated');
  assert.equal(stripShipMarkers(text), 'Done.\nFooter.');
  assert.equal(parseShipMarkers('no markers here'), undefined);
  const report = parseShipMarkers('[ship-report: .consort/ship/TEST-REPORT.md | 7/8]\n[ship-stage: Ready to Test | 7/8 stories pass.]');
  assert.deepEqual(report.tests, { pass: 7, total: 8 });
  const revised = applyShipChange(applyShipChange(after, report, 3000), { stage: 'Revising', feedbackFrom: 'user' }, 4000);
  assert.equal(revised.report, undefined, 'a revision invalidates the report');
  assert.equal(revised.feedbackFrom, 'user');
  assert.equal(applyShipChange(revised, { paused: true }, 5000).paused, true);
  assert.equal(applyShipChange(revised, { paused: false }, 5000).paused, undefined);
});

test('the footer and the buttons follow the stage', () => {
  const f = newShipFeature(ticket, 'hris-address', 1000);
  assert.equal(shipFooter(f), 'Stage: Grilling · Ticket: #494 · Next: /ship');
  assert.equal(shipActions(f)[0].label, 'Continue grilling');
  const ready = applyShipChange(f, { stage: 'Ready to Test', next: '/ship approve' }, 2000);
  assert.deepEqual(shipActions(ready).map((a) => a.id), ['next', 'approve', 'feedback', 'pause']);
  assert.equal(shipActions(ready)[0].command, '/ship approve');
  assert.equal(fillShipCommand('/ship "{text}"', 'say "hi"'), '/ship "say \\"hi\\""');
  const merged = applyShipChange(ready, { stage: 'Closed' }, 3000);
  assert.deepEqual(shipActions(merged), []);
  assert.equal(shipFooter(merged), 'Stage: Closed · Ticket: #494 · Next: none - feature closed');
  assert.equal(shipChatName('approve', ticket), 'ship · #494 · approve');
  assert.equal(shipChatName('next', { ...ticket, source: 'clickup', id: '86akm7a8g' }), 'ship · 86akm7a8g · next');
});

test('the handler follows the stage and the form; the prompt carries the state, the rules and the markers', () => {
  const f = newShipFeature(ticket, 'hris-address', 1000);
  assert.equal(shipHandler(f, { form: 'resume' }), 'grilling');
  assert.equal(shipHandler({ ...f, stage: "Spec'd" }, { form: 'resume' }), 'implementing');
  assert.equal(shipHandler({ ...f, stage: 'Implementing', built: true }, { form: 'resume' }), 'test');
  assert.equal(shipHandler({ ...f, stage: 'Ready to Test' }, { form: 'resume' }), 'reentry');
  assert.equal(shipHandler({ ...f, stage: 'Ready to Test' }, { form: 'approve' }), 'approve');
  assert.equal(shipHandler({ ...f, stage: 'Ready to Test' }, { form: 'feedback', feedback: 'x' }), 'revising');
  assert.equal(shipHandler({ ...f, stage: 'In Review' }, { form: 'pr-loop' }), 'pr-loop');
  assert.equal(shipHandler({ ...f, stage: 'Merged' }, { form: 'resume' }), 'closeout');
  assert.equal(shipHandler({ ...f, stage: 'Implementing' }, { form: 'pause' }), 'pause');
  assert.equal(shipHandler({ ...f, stage: 'Closed' }, { form: 'approve' }), 'closed');
  const p = shipPrompt({ feature: f, form: { form: 'resume' }, worktree: '/w', branch: 'mm/hris-address-494', base: 'origin/development', ticketBody: 'Propagate addresses.' });
  assert.match(p, /Grilling — interrogate/);
  assert.match(p, /Propagate addresses\./);
  assert.match(p, /\[ship-stage: <stage> \| <one-line note>\]/);
  assert.match(p, /never merges/);
  assert.match(p, /The PR targets development/);
  const paused = shipPrompt({ feature: { ...f, stage: 'Implementing', paused: true }, form: { form: 'resume' }, worktree: '/w', branch: 'b', base: 'origin/main' });
  assert.match(paused, /this feature is paused/);
  assert.match(paused, /build it, end at "built"/);
  const rev = shipPrompt({ feature: { ...f, stage: 'Ready to Test' }, form: { form: 'feedback', feedback: 'wrong colour' }, worktree: '/w', branch: 'b', base: 'origin/main' });
  assert.match(rev, /wrong colour/);
  assert.match(rev, /Feedback came from: user/);
});

test('ticket references are read from urls and bare ids', () => {
  assert.equal(clickupIdFrom('https://app.clickup.com/t/86akm7a8g'), '86akm7a8g');
  assert.equal(clickupIdFrom('https://app.clickup.com/t/9013448339/ABC-12'), 'ABC-12');
  assert.equal(clickupIdFrom('86akm7a8g'), '86akm7a8g');
  assert.equal(clickupIdFrom('not an id at all'), undefined);
  assert.deepEqual(githubIssueFrom('https://github.com/aligned/mono/issues/494'), { repo: 'aligned/mono', number: 494 });
  assert.deepEqual(githubIssueFrom('#494'), { number: 494 });
  assert.equal(githubIssueFrom('abc'), undefined);
});

test('every ship turn carries the stage line with "you are here" and the step it is on; a repeat turn is told not to restart', () => {
  const f = newShipFeature(ticket, 'hris-address', 1000);
  assert.equal(shipStageLine(f), "[Grilling ← you are here] → Spec'd → Implementing → Ready to Test → Revising → In Review → Merged → Closed");
  const spec = applyShipChange(f, { stage: "Spec'd", note: 'Grilled in 2 rounds.' }, 2000);
  assert.equal(shipStageLine(spec), "Grilling ✓ → [Spec'd ← you are here] → Implementing → Ready to Test → Revising → In Review → Merged → Closed");
  const review = applyShipChange(spec, { stage: 'In Review' }, 3000);
  assert.match(shipStageLine(review), /Ready to Test ✓ → Revising → \[In Review ← you are here\]/);
  const h = shipTurnHeader(spec, 3);
  assert.match(h, /\/ship status/);
  assert.match(h, /Feature: #494 "HRIS address propagation"/);
  assert.match(h, /This turn's step: Implementing: tickets from SPEC.md/);
  assert.match(h, /turn 3 of this chat at this stage: do not restart/);
  assert.match(h, /Done so far: Grilling \(Started\.\); Spec'd \(Grilled in 2 rounds\.\)/);
  assert.match(h, /Stage: Spec'd · Ticket: #494 · Next: \/ship …/);
  assert.match(shipTurnHeader(f), /First turn at this stage/);
  const p = shipPrompt({ feature: spec, form: { form: 'resume' }, worktree: '/w', branch: 'b', base: 'origin/main' });
  assert.match(p, /Grilling ✓ → \[Spec'd ← you are here\]/);
  // the breakdown moves the stage to Implementing and is written as proposed tickets, so a second Implement never re-derives it
  assert.match(p, /\[ship-stage: Implementing \| Breakdown proposed: <n> tickets\.\]/);
  assert.match(p, /\*\*Status:\*\* proposed/);
  assert.match(p, /never re-derive it/);
});

test('Implementing has two steps, building then the test session; the bar and the observer both name them', () => {
  const f = { ...newShipFeature(ticket, 'hris-address', 1000), stage: 'Implementing' };
  assert.equal(shipStep(f), 'building');
  assert.equal(shipBusyLabel(f), 'Building…');
  const built = { ...f, built: true };
  assert.equal(shipStep(built), 'test session');
  assert.equal(shipBusyLabel(built), 'Test session running…');
  assert.equal(shipStep({ ...built, report: '.consort/ship/TEST-REPORT.md' }), undefined);
  assert.equal(shipStep(newShipFeature(ticket, 'x', 1)), undefined);
  assert.equal(shipBusyLabel(newShipFeature(ticket, 'x', 1)), 'Grilling…');
  const s = shipStatusSummary(built);
  assert.match(s, /Stage now: Implementing \(3 of 8\) · step inside it: test session/);
  assert.match(s, /not the pipeline, so never report it as the ship stage/);
  assert.match(s, /Test session: prove every story/);
  assert.match(s, /Branch pushed and built: yes/);
  assert.match(shipTurnHeader(built), /stage 3 of 8, test session/);
});
