import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceForCheckout } from '../src/shared/workspace.ts';

test('a workspace checkout belongs to its workspace, not its source project', () => {
  const mono = { id: 'mono', name: 'aligned-mono', path: '/repos/aligned-mono', defaultBase: 'origin/main' };
  const api = { id: 'api', name: 'api', path: '/repos/api', defaultBase: 'origin/main' };
  const grouped = { id: 'hris', name: 'HRIS Address', path: '/library/workspaces/hris-address', defaultBase: '', kind: 'workspace', repos: [{ projectId: 'mono', dir: 'aligned-mono' }, { projectId: 'api', dir: 'api' }] };
  const state = { projects: [mono, api, grouped] };
  assert.equal(workspaceForCheckout(state, 'mono', '/library/workspaces/hris-address/aligned-mono')?.id, 'hris');
  assert.equal(workspaceForCheckout(state, 'api', '/library/workspaces/hris-address/api')?.id, 'hris');
  assert.equal(workspaceForCheckout(state, 'mono', '/library/worktrees/aligned-mono/fix'), undefined);
});
