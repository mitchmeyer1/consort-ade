import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artifactLinks } from '../src/shared/artifacts.ts';

test('Markdown artifacts preserve labels, spaces, and source locations', () => {
  const links = artifactLinks('See [Report](</tmp/My Report.pdf>) and [source](src/app.ts:42).');
  assert.deepEqual(links.map(({ label, target }) => ({ label, target })), [
    { label: 'Report', target: '/tmp/My Report.pdf' },
    { label: 'source', target: 'src/app.ts:42' },
  ]);
});
test('bare files and URLs are recognized without splitting URL paths', () => {
  assert.deepEqual(artifactLinks('README.md /tmp/chart.png https://example.com/report.pdf').map((l) => l.target),
    ['README.md', '/tmp/chart.png', 'https://example.com/report.pdf']);
});
test('plain prose is preserved and link spans can reconstruct the input', () => {
  const input = 'Before [a](one.md) after two.csv!';
  const links = artifactLinks(input);
  assert.equal(input.slice(links[0].index, links[0].index + links[0].length), '[a](one.md)');
  assert.deepEqual(artifactLinks('No artifacts here.'), []);
});

test('chat artifacts come only from assistant text and deduplicate repeated file links', async () => {
  const { chatArtifacts } = await import('../src/shared/artifacts.ts');
  const text = (role, value) => ({ role, blocks: [{ type: 'text', text: value }] });
  assert.deepEqual(chatArtifacts([
    text('user', '[Upload](private.csv)'),
    text('system', '[Internal](system.txt)'),
    text('assistant', '[Report](reports/result.pdf) and [Source](src/app.ts:12)'),
    { role: 'assistant', blocks: [{ type: 'tool', output: 'tool-output.json', input: 'tool-input.md' }] },
    text('assistant', '[Report again](reports/result.pdf) [Another line](src/app.ts:30) [Image](chart.png)'),
  ]), [
    { label: 'Report', target: 'reports/result.pdf' },
    { label: 'Source', target: 'src/app.ts:12' },
    { label: 'Image', target: 'chart.png' },
  ]);
});
test('chat artifacts include remote files and local paths, excluding web pages and unsupported schemes', async () => {
  const { chatArtifacts } = await import('../src/shared/artifacts.ts');
  const links = chatArtifacts([{ role: 'assistant', blocks: [{ type: 'text', text:
    '[Site](https://example.com/docs) [PDF](https://example.com/report.pdf?download=1) [Notes](<file:///tmp/My Notes.md>) [Mail](mailto:hello@example.com) [Section](#section) [Run](javascript:alert)'
  }] }]);
  assert.deepEqual(links.map((l) => l.label), ['PDF', 'Notes']);
  assert.deepEqual(chatArtifacts([]), []);
});
