import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKED_TOOLS, LOCAL_DELIVERABLES_PROMPT, isBlockedTool } from '../src/shared/deliverables.ts';
import { readFileSync } from 'node:fs';

test('every chat is told to keep deliverables local and away from Claude Docs', () => {
  assert.match(LOCAL_DELIVERABLES_PROMPT, /local files only/i);
  assert.match(LOCAL_DELIVERABLES_PROMPT, /Never create, update or read Claude Docs/);
  assert.match(LOCAL_DELIVERABLES_PROMPT, /Artifacts drawer/);
  const agents = readFileSync(new URL('../src/main/agents.ts', import.meta.url), 'utf8');
  // both providers get the rule, and the Claude session blocks the connector's tools as well
  assert.equal(agents.split('LOCAL_DELIVERABLES_PROMPT').length - 1, 3, 'import + Claude prompt + Codex prompt');
  assert.match(agents, /disallowedTools: BLOCKED_TOOLS/);
});

test('the block list covers the Claude Docs server and each of its tools, and nothing else', () => {
  assert.ok(BLOCKED_TOOLS.includes('mcp__claude_ai_Claude_Docs'));
  for (const tool of ['batch', 'create', 'delete', 'export', 'guide', 'query', 'read', 'update']) assert.ok(BLOCKED_TOOLS.includes(`mcp__claude_ai_Claude_Docs__${tool}`), tool);
  assert.ok(BLOCKED_TOOLS.every(isBlockedTool));
  assert.equal(isBlockedTool('mcp__claude_ai_Claude_Docs__anything_new'), true);
  assert.equal(isBlockedTool('mcp__claude_ai_Notion__search'), false);
  assert.equal(isBlockedTool('Write'), false);
});
