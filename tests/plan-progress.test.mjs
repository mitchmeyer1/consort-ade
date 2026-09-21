import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advancePlan, finishPlan, isVerifyStep, parsePlan, planStages, PLAN_MARKER, startPlan, STEP_MARKER, VERIFY_STEP, withVerifyStep } from '../src/shared/planProgress.ts';

const T = 1_000_000;
const tool = (name, input, ok) => ({ type: 'tool', id: `${name}-${input}`, name, input, ok });
const msg = (ts, ...blocks) => ({ role: 'assistant', ts, blocks });
const state = (stages) => stages.map((s) => s.state);

test('a plan line becomes steps, on either separator', () => {
  assert.deepEqual(parsePlan('Read the store | Add the field | Run the tests'), ['Read the store', 'Add the field', 'Run the tests']);
  assert.deepEqual(parsePlan('one; two; check it'), ['one', 'two', 'check it']);
  assert.deepEqual(parsePlan(' 1. trim the numbering |  2) and verify it '), ['trim the numbering', 'and verify it']);
});

test('a one-step or empty plan is not a plan', () => {
  assert.deepEqual(parsePlan('just do it'), []);
  assert.deepEqual(parsePlan('  |  '), []);
});

test('the markers match the way the agent is told to write them', () => {
  const text = 'Here we go.\n[plan: read | write | test]\nStarting.\n[step:2]\nNow writing.';
  assert.deepEqual([...text.matchAll(PLAN_MARKER)].map((m) => m[1].trim()), ['read | write | test']);
  assert.deepEqual([...text.matchAll(STEP_MARKER)].map((m) => m[1]), ['2']);
  assert.equal(text.replace(PLAN_MARKER, '').replace(STEP_MARKER, '').includes('['), false, 'markers are strippable');
});

test('the first step starts live and the rest wait', () => {
  const plan = startPlan(['read', 'write', 'test'], T);
  assert.equal(plan.current, 0);
  assert.deepEqual(state(planStages({ plan, messages: [], running: true })), ['active', 'pending', 'pending']);
});

test('advancing finishes everything behind it', () => {
  const plan = advancePlan(startPlan(['read', 'write', 'test'], T), 3, T + 100);
  assert.deepEqual(state(planStages({ plan, messages: [], running: true })), ['done', 'done', 'active']);
  assert.equal(plan.steps[1].doneAt, T + 100);
});

test('a stray backwards marker is ignored', () => {
  const plan = advancePlan(startPlan(['a', 'b', 'c'], T), 3, T + 10);
  assert.equal(advancePlan(plan, 1, T + 20).current, 2);
});

test('a finished run leaves no step hanging', () => {
  const plan = finishPlan(advancePlan(startPlan(['a', 'b'], T), 2, T + 5), T + 50);
  assert.deepEqual(state(planStages({ plan, messages: [], running: false })), ['done', 'done']);
});

test('agents fanned out during a step are counted and named under it', () => {
  const plan = advancePlan(startPlan(['scope', 'fan out', 'write up'], T), 2, T + 100);
  const messages = [
    msg(T + 10, tool('Grep', 'router', true)),
    msg(T + 120, tool('Task', '{"description":"audit src/api/claims.ts","prompt":"..."}', true)),
    msg(T + 130, tool('Task', '{"description":"audit src/ui/Panel.tsx"}', undefined)),
  ];
  const stages = planStages({ plan, messages, running: true });
  assert.equal(stages[0].total, undefined, 'the earlier step had no agents');
  assert.equal(stages[1].total, 2);
  assert.equal(stages[1].done, 1);
  assert.equal(stages[1].detail, '1/2 agents back');
  assert.deepEqual(stages[1].subtasks, [
    { label: 'audit src/api/claims.ts', state: 'done' },
    { label: 'audit src/ui/Panel.tsx', state: 'active' },
  ]);
});

test('agents are attributed to the step that was live, not the latest one', () => {
  let plan = advancePlan(startPlan(['first', 'second'], T), 1, T);
  const messages = [msg(T + 5, tool('Task', 'explore the schema', true))];
  plan = advancePlan(plan, 2, T + 50);
  const stages = planStages({ plan, messages: [...messages, msg(T + 60, tool('Task', 'write the migration', undefined))], running: true });
  assert.equal(stages[0].total, 1);
  assert.deepEqual(stages[0].subtasks, [{ label: 'explore the schema', state: 'done' }]);
  assert.equal(stages[1].total, 1);
});

test('only the first few sub-agents are listed, but all are counted', () => {
  const plan = startPlan(['fan out', 'write up'], T);
  const messages = Array.from({ length: 9 }, (_, i) => msg(T + i, tool('Task', `audit file-${i}.ts`, i < 5 ? true : undefined)));
  const stages = planStages({ plan, messages, running: true });
  assert.equal(stages[0].total, 9);
  assert.equal(stages[0].done, 5);
  assert.equal(stages[0].subtasks.length, 4);
});

test('a chat with no plan gets no panel', () => {
  assert.equal(planStages({ messages: [], running: true }), null);
  assert.equal(planStages({ plan: { steps: [], current: 0, ts: T }, messages: [], running: true }), null);
});


test('a plan that does not end in a check gets one appended', () => {
  assert.deepEqual(parsePlan('read the store | add the field'), ['read the store', 'add the field', VERIFY_STEP]);
  assert.deepEqual(withVerifyStep(['do a thing']), ['do a thing', VERIFY_STEP]);
});

test('a plan that already verifies is left alone', () => {
  for (const last of ['run the tests', 'verify in the browser', 'screenshot the panel', 'typecheck and build', 'confirm the migration']) {
    assert.equal(isVerifyStep(last), true, last);
    assert.deepEqual(withVerifyStep(['change it', last]), ['change it', last]);
  }
});

test('appending the check never pushes the plan over its limit', () => {
  const eight = Array.from({ length: 8 }, (_, i) => `step ${i}`);
  const steps = withVerifyStep(eight);
  assert.equal(steps.length, 8);
  assert.equal(steps.at(-1), VERIFY_STEP);
});

test('a run that stops before verifying reports the step as skipped, not done', () => {
  const plan = finishPlan(startPlan(['change the code', 'run the tests'], T), T + 500);
  const stages = planStages({ plan, messages: [], running: false });
  assert.deepEqual(state(stages), ['done', 'skipped']);
});

test('a run that reaches the last step reports it done', () => {
  const plan = finishPlan(advancePlan(startPlan(['change the code', 'run the tests'], T), 2, T + 10), T + 500);
  assert.deepEqual(state(planStages({ plan, messages: [], running: false })), ['done', 'done']);
});
