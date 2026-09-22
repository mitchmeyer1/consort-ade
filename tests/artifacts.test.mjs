import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artifactLinkAction, artifactLinks, localImageTarget } from '../src/shared/artifacts.ts';
import { marked } from 'marked';

test('rendered Markdown file anchors route to the artifact menu without metadata', () => {
  for (const target of ['reports/result.pdf', '/tmp/My%20Report.pdf', 'src/app.ts:42', 'file:///tmp/report.pdf', 'https://example.com/report.pdf?download=1']) {
    const html = marked.parse(`[Report](${target})`);
    assert.ok(!html.includes('data-artifact'));
    const href = /href="([^"]+)"/.exec(html)?.[1];
    assert.equal(artifactLinkAction(href), 'artifact', target);
  }
});

test('ordinary web links stay external and unsupported links are ignored', () => {
  assert.equal(artifactLinkAction('https://example.com/docs'), 'external');
  for (const target of ['', '#section', 'javascript:alert(1)', 'mailto:hello@example.com']) {
    assert.equal(artifactLinkAction(target), null);
  }
});

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
  let ts = 1000;
  const text = (role, value) => ({ role, ts: ts += 1000, blocks: [{ type: 'text', text: value }] });
  assert.deepEqual(chatArtifacts([
    text('user', '[Upload](private.csv)'),
    text('system', '[Internal](system.txt)'),
    text('assistant', '[Report](reports/result.pdf) and [Source](src/app.ts:12)'),
    { role: 'assistant', ts: 4500, blocks: [{ type: 'tool', output: 'tool-output.json', input: 'tool-input.md' }] },
    text('assistant', '[Report again](reports/result.pdf) [Another line](src/app.ts:30) [Image](chart.png)'),
  ]), [
    { label: 'Report', target: 'reports/result.pdf', linkedAt: 4000, updatedAt: 5000 },
    { label: 'Source', target: 'src/app.ts:12', linkedAt: 4000, updatedAt: 5000 },
    { label: 'Image', target: 'chart.png', linkedAt: 5000, updatedAt: 5000 },
  ]);
});
test('chat artifacts include remote files and local paths, excluding web pages and unsupported schemes', async () => {
  const { chatArtifacts } = await import('../src/shared/artifacts.ts');
  const links = chatArtifacts([{ role: 'assistant', ts: 1, blocks: [{ type: 'text', text:
    '[Site](https://example.com/docs) [PDF](https://example.com/report.pdf?download=1) [Notes](<file:///tmp/My Notes.md>) [Mail](mailto:hello@example.com) [Section](#section) [Run](javascript:alert)'
  }] }]);
  assert.deepEqual(links.map((l) => l.label), ['PDF', 'Notes']);
  assert.deepEqual(chatArtifacts([]), []);
});

test('html previews get the chat scrollbar rules injected before </head>', async () => {
  const { withFrameScrollbars, frameScrollbarStyle } = await import('../src/shared/artifacts.ts');
  const doc = '<!doctype html><html><head><title>x</title><style>body{background:#000}</style></head><body>hi</body></html>';
  const out = withFrameScrollbars(doc);
  assert.ok(out.includes('::-webkit-scrollbar-track{background:transparent}'), 'no track');
  assert.ok(out.indexOf('data-consort-scrollbars') > out.indexOf('body{background:#000}'), 'injected after the document styles');
  assert.ok(out.indexOf('data-consort-scrollbars') < out.indexOf('</head>'), 'injected inside head');
  assert.equal(out.replace(frameScrollbarStyle(), ''), doc, 'nothing else changes');

  assert.ok(withFrameScrollbars('<p>fragment</p>').startsWith('<style data-consort-scrollbars>'), 'a fragment gets the style prepended');
  assert.ok(frameScrollbarStyle('light').includes('rgba(20,19,17,.22)'), 'light theme uses the dark thumb');
  assert.ok(frameScrollbarStyle('dark').includes('rgba(243,234,214,.18)'), 'dark theme uses the pale thumb');
});

test('Markdown images with local paths become artifact targets; web and data images load themselves', () => {
  for (const src of ['readme/img/flow-before.png', '/tmp/chart.png', '~/Desktop/shot.png', 'file:///tmp/erd.png', 'img/My%20Chart.png']) {
    assert.equal(localImageTarget(src), src, src);
  }
  for (const src of ['https://example.com/a.png', 'http://example.com/a.png', 'data:image/png;base64,AAAA', '', null, undefined]) {
    assert.equal(localImageTarget(src), null, String(src));
  }
});
test('rendered Markdown images carry the source path and alt text the chat needs to link them', () => {
  const html = marked.parse('![Flow, before](readme/img/retiring-xano-user-patch/flow-before.png) ![ERD, after](readme/img/erd-after.png)');
  const imgs = [...html.matchAll(/<img src="([^"]+)" alt="([^"]*)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(imgs, [
    ['readme/img/retiring-xano-user-patch/flow-before.png', 'Flow, before'],
    ['readme/img/erd-after.png', 'ERD, after'],
  ]);
  for (const [src] of imgs) assert.equal(localImageTarget(src), src);
});

test('artifact timestamps read as today, yesterday, or a dated clock time', async () => {
  const { artifactWhen } = await import('../src/shared/artifacts.ts');
  const now = new Date(2026, 8, 21, 17, 18).getTime(); // Sep 21 2026, 5:18 PM local
  const at = (y, m, d, h, min) => new Date(y, m, d, h, min).getTime();
  assert.equal(artifactWhen(at(2026, 8, 21, 17, 12), now, 'en-US'), 'Today 5:12 PM');
  assert.equal(artifactWhen(at(2026, 8, 21, 0, 5), now, 'en-US'), 'Today 12:05 AM');
  assert.equal(artifactWhen(at(2026, 8, 20, 23, 59), now, 'en-US'), 'Yesterday 11:59 PM');
  assert.equal(artifactWhen(at(2026, 8, 3, 9, 4), now, 'en-US'), 'Sep 3, 9:04 AM');
  assert.equal(artifactWhen(at(2025, 11, 24, 8, 30), now, 'en-US'), 'Dec 24, 2025, 8:30 AM');
});
