import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listedCodexModels, openAiCodexModels } from '../src/shared/codexModels.ts';

test("Codex's catalog: listed rows only, in Codex's priority order, once each", () => {
  const rows = [
    { slug: 'gpt-6-astra', visibility: 'list', priority: 2 },
    { slug: 'gpt-reserve', visibility: 'hide', priority: 4 },
    { slug: 'gpt-6.1-sol', visibility: 'list', priority: 0 },
    { slug: 'codex-auto-review', visibility: 'hide', priority: 43 },
    { slug: 'gpt-5.5', visibility: 'list' },
    { slug: 'gpt-6-astra', visibility: 'list', priority: 9 },
    { visibility: 'list', priority: 1 },
  ];
  assert.deepEqual(listedCodexModels(rows), ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.5']);
  assert.deepEqual(listedCodexModels(undefined), []);
  assert.deepEqual(listedCodexModels({ not: 'an array' }), []);
});

test("the OpenAI platform's list keeps the GPT and Codex chat models, newest first", () => {
  const rows = [
    { id: 'gpt-5.5', created: 100 },
    { id: 'gpt-6.1-sol', created: 300 },
    { id: 'text-embedding-3-large', created: 500 },
    { id: 'gpt-4o-realtime-preview', created: 400 },
    { id: 'gpt-4o-audio-preview', created: 400 },
    { id: 'gpt-4o-mini-tts', created: 400 },
    { id: 'gpt-4o-transcribe', created: 400 },
    { id: 'gpt-image-1', created: 400 },
    { id: 'gpt-4o-search-preview', created: 400 },
    { id: 'gpt-3.5-turbo-instruct', created: 400 },
    { id: 'gpt-5.5-2026-04-01', created: 400 },
    { id: 'gpt-4-0613', created: 400 },
    { id: 'omni-moderation-latest', created: 400 },
    { id: 'whisper-1', created: 400 },
    { id: 'codex-mini-latest', created: 200 },
    { id: 'o3', created: 250 },
    { id: 42, created: 999 },
  ];
  assert.deepEqual(openAiCodexModels(rows), ['gpt-6.1-sol', 'codex-mini-latest', 'gpt-5.5']);
  assert.deepEqual(openAiCodexModels(null), []);
});
