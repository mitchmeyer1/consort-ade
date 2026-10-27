import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the Slack app manifest asks for the scopes setup lists, and turns on the Home tab and DM replies', () => {
  const manifest = JSON.parse(readFileSync(new URL('../docs/slack-app-manifest.json', import.meta.url), 'utf8'));
  const setup = readFileSync(new URL('../src/cli/setup.ts', import.meta.url), 'utf8');
  const list = setup.slice(setup.indexOf('const SLACK_SCOPES'), setup.indexOf('];', setup.indexOf('const SLACK_SCOPES')));
  const listed = [...list.matchAll(/\["([a-z]+:[a-z]+)"/g)].map(m => m[1]);
  const fromNotes = [...list.matchAll(/\(([a-z]+:[a-z]+) for a private one\)/g)].map(m => m[1]);
  assert.deepEqual([...manifest.oauth_config.scopes.bot].sort(), [...listed, ...fromNotes].sort());
  assert.equal(manifest.features.app_home.home_tab_enabled, true);
  assert.equal(manifest.features.app_home.messages_tab_read_only_enabled, false, 'people must be able to reply in the DM');
  assert.equal(manifest.display_information.name, 'Consort');
});
