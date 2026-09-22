import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserLaunch } from '../src/main/openArtifact.ts';

const chrome = { path: '/Applications/Google Chrome.app', name: 'Google Chrome' };

test('macOS hands the file to the https handler app rather than the file type default', () => {
  assert.deepEqual(browserLaunch('darwin', chrome, '/tmp/My Report.md'),
    { cmd: '/usr/bin/open', args: ['-a', '/Applications/Google Chrome.app', '/tmp/My Report.md'] });
});

test('Windows runs the browser executable with a file URL', () => {
  const launch = browserLaunch('win32', { path: 'C:\\Program Files\\Firefox\\firefox.exe', name: 'Firefox' }, '/tmp/report.html');
  assert.equal(launch.cmd, 'C:\\Program Files\\Firefox\\firefox.exe');
  assert.match(launch.args[0], /^file:\/\/\/.*report\.html$/);
});

test('with no browser known, or on Linux, the caller falls back to the system opener', () => {
  assert.equal(browserLaunch('darwin', undefined, '/tmp/a.md'), null);
  assert.equal(browserLaunch('darwin', { path: '', name: '' }, '/tmp/a.md'), null);
  assert.equal(browserLaunch('linux', chrome, '/tmp/a.md'), null);
});
