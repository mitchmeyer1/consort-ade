import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArticle, parseDiagram, parseFlows, renderDiagram, articleHtml, articleText, areasOf, changedFiles, clip, ARTICLE_RULES } from '../src/shared/prArticle.ts';

const DIAGRAM = {
  nodes: [
    { id: 'page', type: 'page', label: 'User Logins page', status: 'changed' },
    { id: 'route', type: 'route', label: 'POST /api/v1/user-logins/bulk', status: 'new' },
    { id: 'tbl', type: 'table', label: 'user_logins', status: 'existing', columns: [{ name: 'created_via', status: 'new' }, { name: 'legacy_flag', status: 'removed' }] },
    { id: 'ext', type: 'external', label: 'Customer.io', status: 'existing' },
  ],
  edges: [{ from: 'page', to: 'route', label: 'uploads to' }, { from: 'route', to: 'tbl', label: 'writes' }, { from: 'tbl', to: 'page', label: 'refreshes' }, { from: 'ext', to: 'route', label: 'posts to' }],
};
const PR = { repo: 'acme/aligned-mono', number: 687, title: 'feat: sms body webhook', author: 'pmonco', url: 'https://github.com/acme/aligned-mono/pull/687', base: 'development', head: 'abcdef1234567',
  files: [{ filename: 'packages/api/src/external_v1/customerio.ts', status: 'added', additions: 120, deletions: 0 }, { filename: 'packages/core/src/clients/customerio.client.ts', status: 'modified', additions: 30, deletions: 10 }, { filename: 'tests/standard/controller/customerio.test.ts', status: 'added', additions: 16, deletions: 0 }] };
const ARTICLE = { category: 'feature', headline: 'Customer.io SMS bodies now appear on member timelines through a new webhook', body: 'POST /api/external_v1/customerio/sms_event tracks an event with sms_body. Redeliveries do not duplicate.', diagram: DIAGRAM, caption: 'SMS body echoed back onto the timeline',
  flows: [{ status: 'new', steps: ['POST /api/external_v1/customerio/sms_event webhook'], note: 'Records SMS body on the timeline' }, { status: 'bogus', steps: [], note: 'dropped' }, { status: 'removed', steps: ['old cron'], note: '' }] };

test('the diagram is validated: unknown types and statuses fall back, dangling edges drop, and a lone table with columns stands alone', () => {
  const d = parseDiagram({ ...DIAGRAM, nodes: [...DIAGRAM.nodes, { id: 'x', type: 'mystery', label: 'Thing', status: 'odd' }, { id: '', label: 'nameless' }, { id: 'page', label: 'dup' }], edges: [...DIAGRAM.edges, { from: 'page', to: 'ghost', label: 'x' }, { from: 'route', to: 'route', label: 'self' }] });
  assert.equal(d.nodes.length, 5); assert.deepEqual(d.nodes.at(-1), { id: 'x', type: 'service', label: 'Thing', status: 'existing', columns: [] });
  assert.equal(d.edges.length, 4);
  assert.equal(parseDiagram(null), null); assert.equal(parseDiagram({ nodes: [{ id: 'a', label: 'A' }], edges: [] }), null);
  assert.ok(parseDiagram({ nodes: [{ id: 't', type: 'table', label: 'users', columns: [{ name: 'email', status: 'new' }] }] }), 'one table with columns is a diagram');
  assert.equal(parseDiagram({ nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [] }), null, 'two boxes without an arrow are not');
});

test('the diagram draws typed boxes with status badges, column marks, laned arrows and a legend', () => {
  const svg = renderDiagram(parseDiagram(DIAGRAM));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+(\.\d+)? \d+(\.\d+)?"/);
  for (const s of ['>PAGE<', '>API ROUTE<', '>TABLE<', '>EXTERNAL SERVICE<', '>NEW<', '>CHANGED<', '+ created_via', '− legacy_flag', 'stroke-dasharray="5 3"', 'added by this PR', '>changed<', '>removed<', 'uploads to', 'writes', 'refreshes', 'posts to']) assert.ok(svg.includes(s), s);
  assert.equal((svg.match(/<rect x="[\d.]+" y="[\d.]+" width="164"/g) ?? []).length, 4, 'four boxes');
  assert.match(svg, /text-decoration="line-through">− legacy_flag/);
  assert.match(svg, /<title>API route: POST \/api\/v1\/user-logins\/bulk<\/title>/);
  assert.match(renderDiagram(parseDiagram({ nodes: [{ id: 'a', type: 'cron', label: 'nightly-sync', status: 'removed' }, { id: 'b', type: 'queue', label: 'sync-queue' }], edges: [{ from: 'a', to: 'b', label: '' }] })), /stroke-dasharray="5 3"[^>]*\/><text[^>]*>CRON<\/text><text[^>]*>REMOVED<\/text>/);
});

test('an article needs a headline; its flows and diagram are cleaned; the caption goes with the diagram', () => {
  const a = parseArticle(ARTICLE);
  assert.equal(a.category, 'feature'); assert.equal(a.flows.length, 2); assert.deepEqual(a.flows[1], { status: 'removed', steps: ['old cron'], note: '' });
  assert.equal(a.diagram.nodes.length, 4); assert.equal(a.caption, 'SMS body echoed back onto the timeline');
  assert.equal(parseArticle({ ...ARTICLE, diagram: null, category: 'nope' }).caption, ''); assert.equal(parseArticle({ ...ARTICLE, category: 'nope' }).category, 'feature');
  assert.equal(parseArticle({ body: 'no headline' }), null); assert.equal(parseArticle('text'), null); assert.equal(parseArticle(undefined), null);
  assert.deepEqual(parseFlows([{ steps: ['a', 'b', 'c', 'd', 'e'] }]), [{ status: 'changed', steps: ['a', 'b', 'c', 'd'], note: '' }]);
  const text = articleText(a);
  for (const s of ['Customer.io SMS bodies', 'Redeliveries', 'echoed back', 'sms_event webhook', 'Records SMS body', 'User Logins page', 'created_via', 'uploads to']) assert.ok(text.includes(s), s);
});

test('the page: kicker with repo, category and areas; headline linked to the PR; byline; flows; file counts; diagram on the right', () => {
  const html = articleHtml(PR, parseArticle(ARTICLE), new Date('2026-10-27T23:28:00Z'));
  assert.match(html, /<strong class="repo">aligned-mono<\/strong> · Feature · api · core · tests<\/div>/);
  assert.match(html, /<h1><a href="https:\/\/github\.com\/acme\/aligned-mono\/pull\/687">Customer\.io SMS bodies now appear on member timelines through a new webhook<\/a><\/h1>/);
  assert.match(html, /By pmonco · <a [^>]+>#687<\/a> · into development at <code>abcdef1<\/code> · Oct 27, 7:28 PM ET/);
  assert.match(html, /<li class="new"><span class="mark" title="new">\+<\/span><span><code>POST \/api\/external_v1\/customerio\/sms_event webhook<\/code> <span class="arrow">—<\/span> <span class="note">Records SMS body on the timeline<\/span>/);
  assert.match(html, /<li class="removed">.*<code>old cron<\/code><\/span><\/li>/);
  assert.match(html, /3 files · \+166 \/ −10/);
  assert.match(html, /<figure class="figure"><svg [\s\S]*<figcaption>SMS body echoed back onto the timeline<\/figcaption><\/figure>/);
  assert.doesNotMatch(html, /<script/);
  const solo = articleHtml(PR, parseArticle({ ...ARTICLE, diagram: null, flows: [] }));
  assert.match(solo, /<article class="story solo">/); assert.doesNotMatch(solo, /<figure|Flows/);
  assert.match(articleHtml(PR, parseArticle({ ...ARTICLE, headline: 'A <b>bold</b> & "quoted" claim' })), /A &lt;b&gt;bold&lt;\/b&gt; &amp; &quot;quoted&quot; claim/);
});

test('areas come from well-known folders or the top folder; changed files pair numstat with name-status', () => {
  assert.deepEqual(areasOf(['packages/api/src/x.ts', 'packages/frontend-member/src/y.tsx', 'db/migrations/1.sql', '.github/workflows/ci.yml', 'tests/a.test.ts', 'README.md', 'src/cli/slack.ts', 'package.json']), ['api', 'member', 'database', 'infrastructure', 'tests', 'docs', 'cli', 'root']);
  const files = changedFiles('10\t2\tsrc/a.ts\n5\t0\tsrc/b.ts\n-\t-\tlogo.png\n0\t3\told.ts\n', 'M\tsrc/a.ts\nA\tsrc/b.ts\nA\tlogo.png\nD\told.ts\nR100\tfrom.ts\tto.ts\n');
  assert.deepEqual(files, [{ filename: 'src/a.ts', status: 'modified', additions: 10, deletions: 2 }, { filename: 'src/b.ts', status: 'added', additions: 5, deletions: 0 }, { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 }, { filename: 'old.ts', status: 'removed', additions: 0, deletions: 3 }]);
  assert.equal(clip('abcdefghij', 5), 'abcd…'); assert.equal(clip('abc', 5), 'abc');
  assert.match(ARTICLE_RULES, /"headline": ONE plain sentence/); assert.match(ARTICLE_RULES, /Never name or describe a real person/);
});
