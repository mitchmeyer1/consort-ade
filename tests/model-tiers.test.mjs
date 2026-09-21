import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { modelTiers } from '../src/shared/modelTiers.ts';


test('each provider orchestrates on its strongest model and delegates one tier down', () => {
  assert.deepEqual(modelTiers('claude'), { orchestrator: 'claude-fable-5-1', delegate: 'claude-opus-5' });
  assert.deepEqual(modelTiers('codex'), { orchestrator: 'gpt-6-astra', delegate: 'gpt-5.6-sol' });
  for (const provider of ['claude', 'codex']) {
    const { orchestrator, delegate } = modelTiers(provider);
    assert.notEqual(orchestrator, delegate, `${provider} must not delegate to its own tier`);
  }
});

test("a provider's advertised order never decides the tiers", () => {
  // Codex lists by rollout priority, so sol arrives before astra; picking [0]/[1] would invert the tiers.
  const asAdvertised = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra'];
  assert.deepEqual(modelTiers('codex', asAdvertised), { orchestrator: 'gpt-6-astra', delegate: 'gpt-5.6-sol' });
});

test('a dropped model falls back to something the catalog still offers', () => {
  const noAstra = ['gpt-5.6-sol', 'gpt-5.6-terra'];
  assert.deepEqual(modelTiers('codex', noAstra), { orchestrator: 'gpt-5.6-sol', delegate: 'gpt-5.6-sol' });
  const noOpus = ['claude-fable-5-1', 'claude-sonnet-5'];
  const { orchestrator, delegate } = modelTiers('claude', noOpus);
  assert.equal(orchestrator, 'claude-fable-5-1');
  assert.ok(noOpus.includes(delegate), 'delegate must be a model the provider still offers');
  assert.deepEqual(modelTiers('claude', []), modelTiers('claude'));
});

const handlerSource = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
const source = ts.createSourceFile('index.ts', handlerSource, ts.ScriptTarget.Latest, true);
let declaration;
source.forEachChild(node => {
  if (ts.isVariableStatement(node)) for (const item of node.declarationList.declarations) {
    if (item.name.getText(source) === 'handlers') declaration = item.initializer;
  }
});
const addChat = declaration.properties.find(p => p.name.getText(source) === 'addChat');
const compiled = ts.transpileModule(`const handlers = {${addChat.getText(source)}}; return handlers;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const store = {
    data: { keys: [{ id: 'k', provider: 'claude', defaultModel: 'claude-sonnet-5' }], chats: [] },
    save() { this.saved = (this.saved ?? 0) + 1; },
  };
  const deps = {
    randomUUID: () => `chat-${store.data.chats.length}`,
    store,
    selectedModel: (state, key, fallback) => key.defaultModel || fallback,
    MODELS: { claude: ['claude-fable-5-1', 'claude-opus-5'] },
  };
  const handlers = new Function(...Object.keys(deps), compiled)(...Object.values(deps));
  return { handlers, store };
}

test('a review pins both tiers on the chat without disturbing the user model', () => {
  const { handlers, store } = harness();
  const id = handlers.addChat('wt', 'k', { name: 'Review #12', model: 'claude-fable-5-1', delegateModel: 'claude-opus-5', remember: false });
  const chat = store.data.chats.find(c => c.id === id);
  assert.equal(chat.model, 'claude-fable-5-1');
  assert.equal(chat.delegateModel, 'claude-opus-5');
  // the trap: remembering the review's tier would start every later chat on the priciest model
  assert.equal(store.data.keys[0].defaultModel, 'claude-sonnet-5');
});

test('an ordinary chat still remembers the model and delegates nothing', () => {
  const { handlers, store } = harness();
  const id = handlers.addChat('wt', 'k', { model: 'claude-opus-5' });
  const chat = store.data.chats.find(c => c.id === id);
  assert.equal(store.data.keys[0].defaultModel, 'claude-opus-5');
  assert.ok(!('delegateModel' in chat), 'a chat that delegates nothing carries no delegate model');
});

test('only a delegating chat pins the tier for the agents it dispatches', () => {
  const agents = readFileSync(new URL('../src/main/agents.ts', import.meta.url), 'utf8');
  const fn = /const delegateModelEnv = (\(chat[\s\S]*?);\n/.exec(agents);
  assert.ok(fn, 'delegateModelEnv must stay a single readable expression');
  const js = ts.transpileModule(`return ${fn[1]}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const delegateModelEnv = new Function(js)();
  assert.deepEqual(delegateModelEnv({ delegateModel: 'claude-opus-5' }), { CLAUDE_CODE_SUBAGENT_MODEL: 'claude-opus-5' });
  assert.deepEqual(delegateModelEnv({}), {});
  assert.ok(/\.\.\.delegateModelEnv\(chat\)/.test(agents), 'the pin must reach the agent environment');
});

test('the review prompt names the delegate model and keeps the orchestrator off the diff', () => {
  const skillPrompt = declaration.properties.find(p => p.name.getText(source) === 'skillPrompt').getText(source);
  assert.ok(/delegateModel\?: string/.test(skillPrompt), 'skillPrompt must accept the delegate model');
  assert.ok(/\$\{delegateModel\}/.test(skillPrompt), 'the prompt must name the model agents run on');
  assert.ok(/\$\{progress\}\$\{tier\}Run the following skill/.test(skillPrompt), 'the tier instruction must reach the agent');

  const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8');
  const reviews = app.match(/skillPrompt\("pr-writeup"[^)]*\)/g) ?? [];
  assert.equal(reviews.length, 2, 'both review entry points must be covered');
  for (const call of reviews) assert.ok(/tiers\.delegate/.test(call), `review entry point must pass the delegate tier: ${call}`);
  assert.equal((app.match(/delegateModel: tiers\.delegate, remember: false/g) ?? []).length, 2);

  const skill = readFileSync(new URL('../skills/pr-writeup/SKILL.md', import.meta.url), 'utf8');
  assert.ok(/## Model tiers/.test(skill), 'the skill must state the tier split');
  assert.ok(/Do not walk the diff file by file yourself/.test(skill));
  assert.ok(/Tracing is reading, so the file agents do it/.test(skill), 'flow tracing must be delegated too, folded into the file agents');
  assert.ok(/No separate tracer agents/.test(skill), 'no second fleet of agents just to trace flows');
});

test('the review never leaves agents running in the background and shares context through files', () => {
  const skill = readFileSync(new URL('../skills/pr-writeup/SKILL.md', import.meta.url), 'utf8');
  assert.ok(/run_in_background: false/.test(skill), 'a turn that ends with background agents loses their results');
  assert.ok(/\.consort\/pr-review\/brief\.md/.test(skill), 'shared context is written once to the brief');
  assert.ok(/\.consort\/pr-review\/agents\/<slug>\.md/.test(skill), 'agent reports persist so a resume does not re-dispatch');
  assert.ok(!/every 30–45 seconds|five tool calls/.test(skill), 'no running commentary cadence');

  const skillPrompt = declaration.properties.find(p => p.name.getText(source) === 'skillPrompt').getText(source);
  assert.ok(/run_in_background: false/.test(skillPrompt), 'the runtime rule reaches the orchestrator prompt');
  assert.ok(/writeFileSync\(join\(reviewDir, "categories\.md"\)/.test(skillPrompt), 'the agent brief is saved to the worktree for agents to read');
  assert.ok(!/include in every delegated assignment/.test(skillPrompt), 'the brief is no longer pasted per assignment');

  const categories = readFileSync(new URL('../skills/pr-writeup/categories.md', import.meta.url), 'utf8');
  assert.ok(/^FLOW\s+\|/m.test(categories), 'agents return flow records');
  assert.ok(/One COVERED line per file/.test(categories), 'coverage is per file, not per block per concern');
});
