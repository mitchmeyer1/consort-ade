import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_ACTION_LIBRARY, AUTOPILOT_DRIVER_PROMPT, AUTOPILOT_SUGGESTION_PROMPT, parseAutopilotAction, validateAutopilotPlan } from '../src/shared/autopilot.ts';
import { chooseWithJev, validateNavigatorState } from '../src/main/jevNavigator.ts';
import { AUTOPILOT_BLUE, autopilotBorderHtml, autopilotOverlayGeometry, autopilotStopHtml } from '../src/shared/autopilotOverlay.ts';

test('Autopilot accepts the intentionally small desktop action surface', () => {
  assert.deepEqual(parseAutopilotAction({ action: 'observe' }), { action: 'observe' });
  assert.deepEqual(parseAutopilotAction({ action: 'scan' }), { action: 'scan' });
  assert.deepEqual(parseAutopilotAction({ action: 'activate', app: 'Safari' }), { action: 'activate', app: 'Safari' });
  assert.deepEqual(parseAutopilotAction({ action: 'click', x: 120, y: 340 }), { action: 'click', x: 120, y: 340 });
  assert.deepEqual(parseAutopilotAction({ action: 'clickTarget', target: 'ocr-12', generation: '1f27425a-55df-49ac-bd41-17ab4ee72fab' }), { action: 'clickTarget', target: 'ocr-12', generation: '1f27425a-55df-49ac-bd41-17ab4ee72fab' });
  assert.deepEqual(parseAutopilotAction({ action: 'type', text: 'hello' }), { action: 'type', text: 'hello' });
  assert.deepEqual(parseAutopilotAction({ action: 'key', key: 'CMD+S' }), { action: 'key', key: 'cmd+s' });
});

test('Autopilot rejects malformed or overly broad actions', () => {
  for (const action of [
    {},
    { action: 'shell', command: 'rm -rf /' },
    { action: 'click', x: -1, y: 10 },
    { action: 'clickTarget', target: 'button', generation: 'old' },
    { action: 'type', text: '' },
    { action: 'key', key: 'cmd+q' },
    { action: 'activate', app: 'Bad\nApp' },
  ]) assert.throws(() => parseAutopilotAction(action));
});

test('Autopilot validates bounded plans and exposes browser shortcut manifests', () => {
  const plan = validateAutopilotPlan({
    goal: 'Find a birthday', successEvidence: ['Article date is visible'], allowedApps: ['Arc'], confirmationActions: [],
    steps: [{ id: 'open', goal: 'Open Wikipedia', app: 'Arc', actions: ['activate_arc', 'new_tab', 'type_url'], success: 'Wikipedia loads' }],
  });
  assert.equal(plan.steps[0].maxAttempts, 3);
  assert.equal(APP_ACTION_LIBRARY.Arc.newTab, 'cmd+t');
  assert.throws(() => validateAutopilotPlan({ goal: 'x', successEvidence: [], allowedApps: ['Arc'], confirmationActions: [], steps: [] }));
});

test('Jev navigator sends bounded choices and escalates low-confidence decisions', async () => {
  const state = validateNavigatorState({ goal: 'Open result', currentStep: 'Choose link', screen: { targets: ['Wikipedia'] }, candidates: [{ id: 'click_wiki', description: 'Click Wikipedia' }, { id: 'scan_again', description: 'Refresh targets' }] });
  const requests = [];
  const fetcher = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ model: 'typesafe/jev-1.13', answers: { next_action: { type: 'choice', choice: 'click_wiki', confidence: 0.92, probabilities: { click_wiki: 0.92, scan_again: 0.08 } } }, usage: { cost: 0.000001 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const decision = await chooseWithJev('test-key', state, fetcher);
  assert.equal(decision.action, 'click_wiki');
  assert.equal(decision.escalate, false);
  assert.equal(requests[0].model, '~typesafe/jev-latest');
  assert.equal(requests[0].questions.next_action.criteria.escalate.includes('supervising model'), true);

  const low = await chooseWithJev('test-key', state, async () => new Response(JSON.stringify({ answers: { next_action: { choice: 'click_wiki', confidence: 0.4, probabilities: {} } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  assert.equal(low.action, 'escalate');
  assert.equal(low.escalate, true);
  await assert.rejects(() => chooseWithJev('', state, fetcher), /Consort Settings/);
});

test('Autopilot prompts define supervision, escalation, and contextual offers', () => {
  assert.match(AUTOPILOT_DRIVER_PROMPT, /supervisor/i);
  assert.match(AUTOPILOT_DRIVER_PROMPT, /report uncertainty back/i);
  assert.match(AUTOPILOT_DRIVER_PROMPT, /explicit confirmation/i);
  assert.match(AUTOPILOT_SUGGESTION_PROMPT, /Execute with Autopilot/);
});

test('Autopilot overlay visibly identifies control and exposes emergency stop', () => {
  const border = autopilotBorderHtml();
  const stop = autopilotStopHtml();
  assert.match(border, new RegExp(AUTOPILOT_BLUE));
  assert.match(border, /animation:pulse/);
  assert.match(border, /background:#168cff/);
  assert.match(border, /pointer-events|aria-hidden/);
  assert.match(stop, />Stop Consort<\/button>/);
  assert.match(stop, /consort-autopilot-stop:\/\/stop/);
  assert.match(stop, /aria-label="Stop Consort Autopilot"/);
});

test('Autopilot overlay uses full display bounds, including negative origins', () => {
  assert.deepEqual(autopilotOverlayGeometry({ x: 0, y: 0, width: 1440, height: 900 }), {
    edges: [
      { x: 0, y: 0, width: 1440, height: 5 },
      { x: 0, y: 895, width: 1440, height: 5 },
      { x: 0, y: 5, width: 5, height: 890 },
      { x: 1435, y: 5, width: 5, height: 890 },
    ],
    stop: { x: 1250, y: 824, width: 172, height: 58 },
  });
  assert.deepEqual(autopilotOverlayGeometry({ x: -1920, y: -80, width: 1920, height: 1080 }).edges[0], { x: -1920, y: -80, width: 1920, height: 5 });
});

test('the agent is only told to suggest Autopilot once an OpenRouter key exists', async () => {
  const { readFileSync } = await import('node:fs');
  const agents = readFileSync(new URL('../src/main/agents.ts', import.meta.url), 'utf8');
  assert.match(agents, /autopilotAvailable\(\) \? \[AUTOPILOT_SUGGESTION_PROMPT\] : \[\]/);
  assert.match(agents, /getOpenRouterKey/);
});
