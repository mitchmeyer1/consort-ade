import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextPercent, contextTone, contextWindowOf, promptTokens } from '../src/shared/context.ts';

test('the tone bands are green to 30, yellow to 70, red above', () => {
  assert.equal(contextTone(0), 'green');
  assert.equal(contextTone(29), 'green');
  assert.equal(contextTone(30), 'yellow');
  assert.equal(contextTone(69), 'yellow');
  assert.equal(contextTone(70), 'red');
  assert.equal(contextTone(100), 'red');
});

test('percent is the prompt over the window, clamped and rounded', () => {
  assert.equal(contextPercent({ used: 50_000, window: 200_000 }), 25);
  assert.equal(contextPercent({ used: 199_999, window: 200_000 }), 100);
  assert.equal(contextPercent({ used: 300_000, window: 200_000 }), 100);
  assert.equal(contextPercent({ used: 1, window: 0 }), 0);
});

test('the prompt size is input plus both cache figures of one API call', () => {
  assert.equal(promptTokens({ input_tokens: 12, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000, output_tokens: 900 }), 42_012);
  assert.equal(promptTokens({ output_tokens: 3 }), undefined);
  assert.equal(promptTokens(null), undefined);
});

test('the window comes from the chat model when listed, else from the model that carried the turn', () => {
  const usage = {
    'claude-haiku-4-5-20251001': { contextWindow: 200_000, inputTokens: 5, cacheReadInputTokens: 0 },
    'claude-opus-5': { contextWindow: 1_000_000, inputTokens: 900, cacheReadInputTokens: 80_000 },
  };
  assert.equal(contextWindowOf(usage, 'claude-opus-5'), 1_000_000);
  assert.equal(contextWindowOf(usage, 'haiku-4-5'), 200_000);
  assert.equal(contextWindowOf(usage, 'sonnet'), 1_000_000);
  assert.equal(contextWindowOf({}, 'sonnet'), undefined);
});
