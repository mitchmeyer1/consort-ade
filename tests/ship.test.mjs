import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyShipChange, clickupIdFrom, fillShipCommand, githubIssueFrom, isShipCommand, newShipFeature, parseShipCommand, parseShipMarkers, shipActions, shipBranch, shipBusyLabel, shipReviewRoundToStart, shipStep, prNumberFromUrl, shipChatName, shipFooter, shipSlug, stageLabel, stripShipMarkers, withBranchPrefix } from '../src/shared/ship.ts';
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
  assert.equal(shipHandler({ ...f, stage: "Spec'd", built: true }, { form: 'resume' }), 'test');
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
  assert.equal(shipBusyLabel(built), 'Testing…');
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

test("In Review is Consort's own PR review: round 1 starts on entry, later rounds on the agent's marker, three at most", () => {
  const f = newShipFeature(ticket, 'hris-address', 1000);
  const ready = { ...f, stage: 'Ready to Test', prs: ['https://github.com/aligned/mono/pull/525'] };
  const review = applyShipChange(ready, { stage: 'In Review' }, 2000);
  assert.equal(shipReviewRoundToStart(ready, review), 1);
  assert.equal(shipReviewRoundToStart(ready, { ...review, prs: [] }), undefined, 'no PR, nothing to review');
  assert.equal(shipReviewRoundToStart(ready, { ...review, paused: true }), undefined);
  const r1 = { ...review, reviewRound: 1 };
  assert.equal(shipReviewRoundToStart(r1, applyShipChange(r1, { next: '/ship pr-loop' }, 3000)), undefined, 'a plain pr-loop turn starts nothing');
  assert.equal(shipReviewRoundToStart(r1, applyShipChange(r1, { reviewRound: 2 }, 3000)), 2);
  const r3 = { ...review, reviewRound: 3 };
  assert.equal(shipReviewRoundToStart(r3, applyShipChange(r3, { reviewRound: 4 }, 3000)), undefined, 'capped');
  const revising = { ...r1, stage: 'Revising' };
  assert.equal(shipReviewRoundToStart(revising, applyShipChange(revising, { stage: 'In Review' }, 4000)), 2, 're-entering review after fixes reviews the new head');
  assert.equal(prNumberFromUrl('https://github.com/aligned/mono/pull/525'), 525);
  assert.equal(prNumberFromUrl('https://github.com/aligned/mono/issues/525'), undefined);
  assert.equal(shipBusyLabel({ ...review, review: { chatId: 'c', pr: 525, round: 1, startedAt: 1 } }), 'Reviewing (round 1)…');
});

test('approve hands the PR to the self-review and pr-loop works from its file, never an outside bot', () => {
  const f = { ...newShipFeature(ticket, 'hris-address', 1000), stage: 'Ready to Test', prs: ['https://github.com/aligned/mono/pull/525'] };
  const approve = shipPrompt({ feature: f, form: { form: 'approve' }, worktree: '/w', branch: 'b', base: 'origin/development' });
  assert.match(approve, /Consort queues its own AI self-review .* as the next turn of this very chat/);
  assert.match(approve, /Do not trigger any reviewer/);
  assert.doesNotMatch(approve, /ai-review/);
  const inReview = { ...f, stage: 'In Review', reviewRound: 1, review: { chatId: 'c', pr: 525, round: 1, startedAt: 1, doneAt: 2 } };
  const summary = { pr: 525, title: 't', url: 'u', reviewedAt: 'x', total: 6, pending: 3, queued: 1, commented: 0, ignored: 2, fixing: 0, submitted: 0 };
  const loop = shipPrompt({ feature: inReview, form: { form: 'pr-loop' }, worktree: '/w', branch: 'b', base: 'origin/development', review: { running: false, summary } });
  assert.match(loop, /\.consort\/pr-review\/pr-525\.review\.json/);
  assert.match(loop, /Self-review: round 1 of 3 done .* 6 finding\(s\): 3 undecided, 1 approved to post, 0 on the PR, 2 ignored/);
  assert.match(loop, /status "ignored" is the user's decision, skip it/);
  assert.match(loop, /Never edit that file/);
  assert.match(loop, /\[ship-review-round: 2\]/);
  const running = shipPrompt({ feature: inReview, form: { form: 'pr-loop' }, worktree: '/w', branch: 'b', base: 'origin/development', review: { running: true } });
  assert.match(running, /RUNNING now in this worktree/);
});

test("the ticket is written into the worktree as TICKET.md so any message in a ship chat can read it, and every ship prompt says where", async () => {
  const { TICKET_FILE, ticketMarkdown } = await import('../src/shared/ship.ts');
  assert.equal(TICKET_FILE, '.consort/ship/TICKET.md');
  const md = ticketMarkdown({ source: 'clickup', id: '17thtp0hvw7', url: 'https://app.clickup.com/t/17thtp0hvw7', title: 'Scope October Sprint Scope for APC Admin' }, { body: 'Build a sized list.\n\n- item', status: 'to do', at: Date.UTC(2026, 9, 1) });
  assert.match(md, /^# Scope October Sprint Scope for APC Admin\n/);
  assert.match(md, /- Source: ClickUp task 17thtp0hvw7\n- URL: https:\/\/app\.clickup\.com\/t\/17thtp0hvw7\n- Status in the tracker: to do\n- Fetched by Consort: 2026-10-01T00:00:00\.000Z/);
  assert.match(md, /## Description\n\nBuild a sized list\.\n\n- item\n$/);
  assert.match(ticketMarkdown(ticket, { body: '  ', at: 0 }), /GitHub issue #494 in aligned\/mono[\s\S]*_The ticket has no description\._/);
  const f = newShipFeature(ticket, 'hris-address', 1000);
  assert.match(shipTurnHeader(f, 2), /full text .* is in \.consort\/ship\/TICKET\.md, written by Consort; read it before answering/);
  assert.match(shipPrompt({ feature: f, form: { form: 'resume' }, worktree: '/w', branch: 'b', base: 'origin/main' }), /TICKET\.md \(the ticket's text, written by Consort each turn/);
});

test('the Ship box resolves a ticket from either tracker by id or link, and nothing from noise', async () => {
  const { shipTarget, SHIP_BLURB } = await import('../src/shared/ship.ts');
  assert.deepEqual(shipTarget('github', '#494'), { source: 'github', number: 494 });
  assert.deepEqual(shipTarget('github', 'https://github.com/aligned/mono/issues/494'), { source: 'github', number: 494 });
  assert.deepEqual(shipTarget('clickup', 'https://app.clickup.com/t/17thtp0hvw7'), { source: 'clickup', id: '17thtp0hvw7' });
  assert.equal(shipTarget('github', 'https://app.clickup.com/t/17thtp0hvw7'), undefined);
  assert.match(SHIP_BLURB, /start to finish/);
});

test("the TICKET box reads the tracker's own completion: ClickUp status types, a GitHub issue's task list, the ticket row first", async () => {
  const { clickupStatusDone, githubTaskList, ticketStages } = await import('../src/shared/ship.ts');
  assert.equal(clickupStatusDone({ status: 'Weird Name', type: 'closed' }), true);
  assert.equal(clickupStatusDone({ status: 'done', type: 'custom' }), true);
  assert.equal(clickupStatusDone({ status: 'in progress', type: 'custom' }), false);
  assert.equal(clickupStatusDone(undefined), false);
  const subs = githubTaskList('Intro\n- [ ] write the migration\n- [x] add the index\n  * [X] nested done\n1. [ ] numbered\n- plain bullet\n', 'https://github.com/o/r/issues/1');
  assert.deepEqual(subs.map((s) => [s.title, s.done, s.status]), [['write the migration', false, 'open'], ['add the index', true, 'done'], ['nested done', true, 'done'], ['numbered', false, 'open']]);
  assert.equal(subs[0].url, 'https://github.com/o/r/issues/1');
  const unread = ticketStages(ticket, undefined);
  assert.deepEqual(unread, [{ id: 'ticket', label: 'HRIS address propagation', state: 'pending', detail: 'not read yet' }]);
  const rows = ticketStages(ticket, { title: 'HRIS address propagation (renamed)', status: 'in progress', done: false, at: 1, subtasks: [{ id: 's1', title: 'Backfill', status: 'complete', done: true }, { id: 's2', title: 'Sync job', status: 'to do', done: false }] });
  assert.deepEqual(rows.map((r) => [r.label, r.state, r.detail]), [['HRIS address propagation (renamed)', 'pending', 'in progress'], ['Backfill', 'done', 'complete'], ['Sync job', 'pending', 'to do']]);
  assert.equal(ticketStages(ticket, { title: 't', status: 'closed', done: true, at: 1, subtasks: [] })[0].state, 'done');
});

test('the SHIP card lists the stages the feature passes through with a line each, detours only when taken', async () => {
  const { shipPanelStages, SHIP_STAGE_INFO, SHIP_STAGES } = await import('../src/shared/ship.ts');
  for (const s of SHIP_STAGES) assert.ok(SHIP_STAGE_INFO[s].blurb.length > 20, s);
  const f = newShipFeature(ticket, 'hris-address', 1000);
  const fresh = shipPanelStages(f);
  assert.deepEqual(fresh.map((r) => [r.id, r.state]), [['Grilling', 'active'], ["Spec'd", 'pending'], ['Implementing', 'pending'], ['Ready to Test', 'pending'], ['In Review', 'pending'], ['Merged', 'pending']], 'no Revising, no Closed until taken');
  assert.equal(fresh[0].detail, SHIP_STAGE_INFO.Grilling.blurb);
  const building = applyShipChange(applyShipChange(f, { stage: "Spec'd" }, 2000), { stage: 'Implementing' }, 3000);
  assert.deepEqual(shipPanelStages(building).map((r) => [r.label, r.state]).slice(0, 3), [['Grilling', 'done'], ["Spec'd", 'done'], ['Implementing · building', 'active']]);
  const revising = applyShipChange(applyShipChange(building, { stage: 'Ready to Test' }, 4000), { stage: 'Revising' }, 5000);
  assert.deepEqual(shipPanelStages(revising).map((r) => r.id), ['Grilling', "Spec'd", 'Implementing', 'Ready to Test', 'Revising', 'In Review', 'Merged']);
  const merged = applyShipChange(applyShipChange(revising, { stage: 'In Review' }, 6000), { stage: 'Merged' }, 7000);
  assert.ok(shipPanelStages(merged).every((r) => r.state === 'done'));
  const closed = applyShipChange(building, { stage: 'Closed' }, 9000);
  const ids = shipPanelStages(closed).map((r) => r.id);
  assert.ok(ids.includes('Closed') && !ids.includes('Merged'));
});

test('Redo rewinds a finished stage: the command parses, only finished stages qualify, and downstream state is forgotten', async () => {
  const { canRedoStage, redoShipChange, stageNamed } = await import('../src/shared/ship.ts');
  const { shipHandler } = await import('../src/shared/shipPrompt.ts');
  assert.deepEqual(parseShipCommand('/ship redo Ready to Test'), { form: 'redo', stage: 'Ready to Test' });
  assert.deepEqual(parseShipCommand('/ship redo ready-to-test'), { form: 'redo', stage: 'Ready to Test' });
  assert.deepEqual(parseShipCommand('/ship 494 redo grilling'), { form: 'redo', stage: 'Grilling', ref: '494' });
  assert.deepEqual(parseShipCommand('/ship redo'), { form: 'redo' });
  assert.equal(stageNamed("spec'd"), "Spec'd");
  let f = newShipFeature(ticket, 'hris-address', 1000);
  f = applyShipChange(f, { stage: "Spec'd", spec: '.consort/ship/SPEC.md' }, 2000);
  f = applyShipChange(f, { stage: 'Implementing' }, 3000);
  f = applyShipChange(f, { built: true, prs: ['https://github.com/o/r/pull/9'] }, 3500);
  f = applyShipChange(f, { stage: 'Ready to Test', report: '.consort/ship/TEST-REPORT.md', tests: { pass: 4, total: 4 } }, 4000);
  f = applyShipChange(f, { stage: 'In Review', reviewRound: 1 }, 5000);
  f = { ...f, review: { chatId: 'c', pr: 9, round: 1, startedAt: 5000, doneAt: 6000 } };
  assert.equal(canRedoStage(f, 'Grilling'), true);
  assert.equal(canRedoStage(f, 'Ready to Test'), true);
  assert.equal(canRedoStage(f, 'In Review'), false, 'the current stage is not finished');
  assert.equal(canRedoStage(f, 'Merged'), false);
  const tests = redoShipChange(f, 'Ready to Test', 7000);
  assert.equal(tests.stage, 'Implementing');
  assert.equal(tests.built, true, 'the branch is still built; only the test session reruns');
  assert.equal(tests.report, undefined);
  assert.equal(tests.review, undefined);
  assert.deepEqual(tests.prs, f.prs, 'the PR stays');
  assert.match(tests.history.at(-1).note, /Redo requested: Ready to Test/);
  assert.equal(shipHandler(tests, { form: 'redo', stage: 'Ready to Test' }), 'test');
  const grill = redoShipChange(f, 'Grilling', 7000);
  assert.equal(grill.stage, 'Grilling');
  assert.equal(grill.spec, undefined);
  assert.equal(grill.built, undefined);
  assert.equal(shipHandler(grill, { form: 'redo', stage: 'Grilling' }), 'grilling');
  const build = redoShipChange(f, 'Implementing', 7000);
  assert.equal(build.built, undefined);
  assert.equal(shipHandler(build, { form: 'redo', stage: 'Implementing' }), 'implementing');
  assert.match(shipPrompt({ feature: tests, form: { form: 'redo', stage: 'Ready to Test' }, worktree: '/w', branch: 'b', base: 'origin/main' }), /## Redo: Ready to Test[\s\S]*do the stage again properly/);
  assert.equal(canRedoStage(applyShipChange(f, { stage: 'Merged' }, 8000), 'Grilling'), false, 'nothing to redo once merged');
});

test('headless approval keeps the PR draft until the CLI publishes evidence', () => {
  const feature = { ...newShipFeature(ticket, 'test-feature', 1000), stage: 'Ready to Test' };
  const args = { feature, form: { form: 'approve' }, worktree: '/w', branch: 'b', base: 'origin/main' };
  const headless = shipPrompt({ ...args, headless: true });
  assert.match(headless, /Keep the PR in draft/);
  assert.match(headless, /published to both the PR and ticket/);
  assert.doesNotMatch(headless, /gh pr ready/);
  assert.match(shipPrompt(args), /gh pr ready/);
});
