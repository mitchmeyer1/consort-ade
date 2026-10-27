/**
 * The PR article: one newspaper-style page that says what a PR does, posted in the review thread
 * when the owner is asked to approve. The overview model writes the story as JSON (headline, body,
 * category, flows, a typed diagram); this module validates it and renders the page and the diagram,
 * so every article reads and draws the same way. Ported from aligned-mono's Daily Dev digest.
 */

export const STORY_CATEGORIES = ["feature", "infrastructure", "database", "fix", "chore"] as const;
export type StoryCategory = (typeof STORY_CATEGORIES)[number];
export const DIAGRAM_NODE_TYPES = ["person", "page", "route", "service", "worker", "cron", "queue", "table", "collection", "storage", "external", "infra", "ci"] as const;
export type DiagramNodeType = (typeof DIAGRAM_NODE_TYPES)[number];
export const DIAGRAM_STATUSES = ["new", "changed", "removed", "existing"] as const;
export type DiagramStatus = (typeof DIAGRAM_STATUSES)[number];

export interface DiagramColumn { name: string; status: DiagramStatus }
export interface DiagramNode { id: string; type: DiagramNodeType; label: string; status: DiagramStatus; columns: DiagramColumn[] }
export interface DiagramEdge { from: string; to: string; label: string }
export interface ArticleDiagram { nodes: DiagramNode[]; edges: DiagramEdge[] }
/** An entry point as a reader meets it: `steps` from where it starts to what runs. */
export interface ArticleFlow { status: Exclude<DiagramStatus, "existing">; steps: string[]; note: string }
export interface PrArticle {
  category: StoryCategory;
  /** One plain sentence. */
  headline: string;
  /** Two or three short sentences. */
  body: string;
  diagram: ArticleDiagram | null;
  caption: string;
  flows: ArticleFlow[];
}
/** A changed file as `git diff --numstat` and `--name-status` report it. */
export interface ChangedFile { filename: string; status: "added" | "modified" | "removed" | "renamed"; additions: number; deletions: number }
export interface PrFacts { repo: string; number: number; title: string; author: string; url: string; base: string; head: string; files: ChangedFile[] }

const MAX_NODES = 7, MAX_EDGES = 10, MAX_COLUMNS = 6, MAX_PER_ROW = 3, MAX_FLOWS = 6, MAX_FLOW_STEPS = 4;
const LABEL_CHARS = 23, MONO_LABEL_CHARS = 21, EDGE_LABEL_CHARS = 18;
const NODE_W = 164, HEAD_H = 46, COL_H = 16, GAP_X = 18, GAP_Y = 46, PAD = 14, LANE_STEP = 12, EDGE_CHAR_W = 5.8, LEGEND_H = 22;
const SANS = `-apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
const INK = "#152A2D", MUTED = "#5B6B6E";

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** `s` cut to `max` code points with an ellipsis, so a label never overruns its box. */
export const clip = (s: string, max: number) => { const chars = [...s]; return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : s; };
const oneOf = <T extends string>(allowed: readonly T[], value: unknown, fallback: T): T => (typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback);

// ── validation ────────────────────────────────────────────────────────────────

/** Unknown node types become services, unknown statuses existing, edges to missing boxes are dropped. Null unless two linked boxes, or one table with columns. */
export function parseDiagram(raw: unknown): ArticleDiagram | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(r.nodes)) return null;
  const nodes: DiagramNode[] = [];
  for (const n of r.nodes.slice(0, MAX_NODES) as Array<Record<string, unknown>>) {
    if (typeof n !== "object" || n === null) continue;
    const id = String(n["id"] ?? "").trim(), label = String(n["label"] ?? "").trim();
    if (!id || !label || nodes.some((x) => x.id === id)) continue;
    const columns = (Array.isArray(n["columns"]) ? (n["columns"] as Array<Record<string, unknown>>) : [])
      .filter((c) => typeof c === "object" && c !== null && String(c["name"] ?? "").trim()).slice(0, MAX_COLUMNS)
      .map((c) => ({ name: String(c["name"]).trim(), status: oneOf(DIAGRAM_STATUSES, c["status"], "existing") }));
    nodes.push({ id, label, type: oneOf(DIAGRAM_NODE_TYPES, n["type"], "service"), status: oneOf(DIAGRAM_STATUSES, n["status"], "existing"), columns });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(r.edges) ? (r.edges as Array<Record<string, unknown>>) : []).filter((e) => typeof e === "object" && e !== null)
    .map((e) => ({ from: String(e["from"] ?? ""), to: String(e["to"] ?? ""), label: String(e["label"] ?? "").trim() }))
    .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to).slice(0, MAX_EDGES);
  const lone = nodes.length === 1 && nodes[0]!.columns.length > 0;
  if (!lone && (nodes.length < 2 || edges.length === 0)) return null;
  return { nodes, edges };
}

/** Flows cleaned: a missing or unknown status reads as changed; entries without steps are dropped. */
export function parseFlows(raw: unknown): ArticleFlow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
    .map((f): ArticleFlow => ({ status: f["status"] === "new" ? "new" : f["status"] === "removed" ? "removed" : "changed", steps: (Array.isArray(f["steps"]) ? f["steps"] : []).map((x) => String(x).trim()).filter(Boolean).slice(0, MAX_FLOW_STEPS), note: String(f["note"] ?? "").trim() }))
    .filter((f) => f.steps.length > 0).slice(0, MAX_FLOWS);
}

/** The overview model's article, or null when it wrote none worth printing (no headline). */
export function parseArticle(raw: unknown): PrArticle | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  const headline = String(a["headline"] ?? "").trim();
  if (!headline) return null;
  const diagram = parseDiagram(a["diagram"]);
  return { category: oneOf(STORY_CATEGORIES, a["category"], "feature"), headline, body: String(a["body"] ?? "").trim(), diagram, caption: diagram ? String(a["caption"] ?? "").trim() : "", flows: parseFlows(a["flows"]) };
}

/** Every word a reader sees, for the PII gate: prose, flows and diagram labels. */
export function articleText(a: PrArticle): string {
  return [a.headline, a.body, a.caption, ...a.flows.flatMap((f) => [...f.steps, f.note]), ...(a.diagram?.nodes.flatMap((n) => [n.label, ...n.columns.map((c) => c.name)]) ?? []), ...(a.diagram?.edges.map((e) => e.label) ?? [])].filter(Boolean).join("\n");
}

/** Areas of the repo a set of paths touches: well-known folders by name, otherwise the top folder. */
export function areasOf(paths: string[]): string[] {
  const known: [RegExp, string][] = [
    [/^(db\/migrations\/|migrations\/|prisma\/|drizzle\/)/, "database"], [/^(infra\/|terraform\/|sst\.config\.|\.github\/|docker|Dockerfile|k8s\/|helm\/)/, "infrastructure"],
    [/^(tests?\/|__tests__\/|e2e\/|spec\/|playwright|vitest|jest)/, "tests"], [/^(docs?\/|readme\/|README|CLAUDE\.md|AGENTS\.md)|\.md$/i, "docs"],
  ];
  const areaOf = (p: string) => {
    for (const [re, area] of known) if (re.test(p)) return area;
    const parts = p.split("/");
    const named = ["packages", "apps", "services", "libs", "src"].includes(parts[0]!) && parts.length > 2 ? parts[1]! : parts.length > 1 ? parts[0]! : "root";
    return named.replace(/^frontend-/, "").replace(/[-_]/g, " ");
  };
  return [...new Set(paths.map(areaOf))];
}

/** `git diff --numstat` plus `--name-status` lines, paired by path. */
export function changedFiles(numstat: string, nameStatus: string): ChangedFile[] {
  const status = new Map<string, ChangedFile["status"]>();
  for (const line of nameStatus.split("\n")) {
    const m = line.match(/^([AMDR])\S*\t(.+?)(?:\t(.+))?$/);
    if (m) status.set(m[3] ?? m[2]!, m[1] === "A" ? "added" : m[1] === "D" ? "removed" : m[1] === "R" ? "renamed" : "modified");
  }
  return numstat.split("\n").flatMap((line) => {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) return [];
    const filename = m[3]!.replace(/^.*\{.* => (.*)\}.*$/, (_, to) => to).replace(/^(.*) => (.*)$/, "$2");
    return [{ filename, status: status.get(filename) ?? "modified", additions: m[1] === "-" ? 0 : Number(m[1]), deletions: m[2] === "-" ? 0 : Number(m[2]) }];
  });
}

// ── the prompt ────────────────────────────────────────────────────────────────

/** House style for the article, appended to the overview prompt; the model writes JSON, never SVG. */
export const ARTICLE_RULES = `"article": the PR as a one-story newspaper page the owner reads in a minute before approving. Write it from the diff, in this house style:
  - "headline": ONE plain sentence, at most 14 words, that says what changed and for whom. No jargon, no PR-speak, no colons.
  - "body": two or three short sentences, at most 60 words. Name the real thing (table, column, job, route, page, function); skip adjectives.
  - "category": "feature" (behaviour people can see or use) | "infrastructure" (deploy, CI, config, cloud resources) | "database" (migrations, tables, columns, indexes) | "fix" (a bug fixed) | "chore" (refactors, tests, docs, tooling).
  - "diagram": the one picture that explains the change, as JSON: {"nodes": [{"id", "type", "label", "status", "columns"?: [{"name", "status"}]}], "edges": [{"from", "to", "label"}]}. Pick one view: a flow (what starts it → the route, service or worker that runs → the tables, queues, buckets or external services it reads or writes), an ERD (the tables touched, each listing only the columns this PR added, changed or removed, edges labelled with the foreign key), or a pipeline (CI job → artifact → resources). 2 to 6 nodes; every node a real, named thing from the diff, never an abstract step like "Validate" or "Done". "label" at most 24 characters. "type": ${DIAGRAM_NODE_TYPES.join(" | ")}. "status": new | changed | removed | existing, for what this PR did to the node or column. Every edge has a 1 to 3 word verb label (writes, reads, calls, posts to, FK user_id). null when no picture would help (a one-line fix, docs, a test-only change).
  - "caption": at most 10 words saying what the diagram shows; "" when diagram is null.
  - "flows": one entry per entry point this PR added, changed or removed (pages, API routes, crons, workers, webhooks, CI workflows): {"status": "new" | "changed" | "removed", "steps": ["<start first, e.g. a page, then METHOD /path>"], "note": "<at most 10 words on what it does now>"}. Never services, classes or tables. [] when the PR touches no entry point.
  Do not invent changes the diff does not show. Never name or describe a real person: no names, emails, phone numbers, birth dates, addresses or IDs, even when the PR shows them.`;

// ── rendering ─────────────────────────────────────────────────────────────────

const SECTION_TITLE: Record<StoryCategory, string> = { feature: "Feature", infrastructure: "Infrastructure", database: "Database", fix: "Fix", chore: "Housekeeping" };
const FLOW_MARK: Record<ArticleFlow["status"], string> = { new: "+", changed: "▲", removed: "−" };

/** The page: kicker, headline, byline, body, flows and the file count on the left; the diagram on the right. Self-contained, no script. */
export function articleHtml(pr: PrFacts, a: PrArticle, now: Date = new Date()): string {
  const repo = pr.repo.split("/").pop() || pr.repo;
  const additions = pr.files.reduce((n, f) => n + f.additions, 0), deletions = pr.files.reduce((n, f) => n + f.deletions, 0);
  const areas = areasOf(pr.files.map((f) => f.filename)).filter((x) => x !== a.category);
  const figure = a.diagram ? `<figure class="figure">${renderDiagram(a.diagram)}${a.caption ? `<figcaption>${escapeHtml(a.caption)}</figcaption>` : ""}</figure>` : "";
  const flows = a.flows.length ? `<div class="flows sans"><h4>Flows</h4><ul>${a.flows.map((f) => `<li class="${f.status}"><span class="mark" title="${f.status}">${FLOW_MARK[f.status]}</span><span>${f.steps.map((s) => `<code>${escapeHtml(s)}</code>`).join(`<span class="arrow">→</span>`)}${f.note ? ` <span class="arrow">—</span> <span class="note">${escapeHtml(f.note)}</span>` : ""}</span></li>`).join("")}</ul></div>` : "";
  const stamp = now.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(a.headline)} — PR #${pr.number}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;1,6..72,400&family=Playfair+Display:wght@700;900&display=swap">
<style>
  :root { --ink: #111; --primary: #152A2D; --accent: #4A7C59; --muted: #555; --rule: #222; --paper: #FBFAF6; }
  * { box-sizing: border-box; }
  body { margin: 0 auto; max-width: 1180px; padding: 28px 36px 40px; background: var(--paper); color: var(--ink); font-family: Newsreader, Georgia, "Times New Roman", serif; font-size: 17px; line-height: 1.5; }
  h1 { font-family: "Playfair Display", Georgia, serif; }
  .sans { font-family: ${SANS}; }
  .story { display: grid; grid-template-columns: 1fr 540px; gap: 28px; align-items: start; }
  .story.solo { grid-template-columns: 1fr; }
  .kicker { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--accent); }
  .kicker .repo { font-weight: 800; color: var(--ink); }
  h1 { font-size: 34px; line-height: 1.15; margin: 4px 0 8px; }
  h1 a { color: inherit; text-decoration: none; }
  h1 a:hover { text-decoration: underline; }
  .byline { font-size: 12px; color: var(--muted); margin-bottom: 12px; }
  .byline a { color: var(--muted); }
  .figure { margin: 0; }
  .figure svg { max-width: 100%; height: auto; display: block; margin: 0 auto; background: #FFF; border: 1px solid #DDD; }
  .figure figcaption { font-size: 13px; color: var(--muted); margin-top: 4px; font-style: italic; text-align: center; }
  p { margin: 0 0 8px; }
  .meta { font-size: 11px; color: var(--muted); }
  .flows { margin: 12px 0 10px; }
  .flows h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); margin: 0 0 6px; font-weight: 600; }
  .flows ul { list-style: none; margin: 0; padding: 0; }
  .flows li { display: flex; gap: 8px; align-items: baseline; font-size: 13px; line-height: 1.4; margin-bottom: 5px; }
  .flows .mark { flex: none; width: 16px; text-align: center; font-weight: 700; }
  .flows .new .mark { color: #2F7D4A; }
  .flows .changed .mark { color: #C27A00; font-size: 11px; }
  .flows .removed .mark { color: #B03A2E; }
  .flows code { font-family: ${MONO}; font-size: 12px; background: #EEF0EC; padding: 1px 5px; border-radius: 3px; }
  .flows .removed code { text-decoration: line-through; }
  .flows .arrow { color: var(--muted); margin: 0 4px; }
  .flows .note { color: #333; }
  footer { margin-top: 26px; border-top: 1px solid var(--rule); padding-top: 8px; font-size: 11px; color: var(--muted); }
  @media (max-width: 760px) { .story { grid-template-columns: 1fr; } }
  @media print { body { padding: 10px; background: #FFF; } }
</style>
</head>
<body>
<article class="story${figure ? "" : " solo"}">
  <div>
    <div class="kicker sans"><strong class="repo">${escapeHtml(repo)}</strong> · ${SECTION_TITLE[a.category]}${areas.length ? ` · ${escapeHtml(areas.join(" · "))}` : ""}</div>
    <h1><a href="${escapeHtml(pr.url)}">${escapeHtml(a.headline)}</a></h1>
    <div class="byline sans">By ${escapeHtml(pr.author)} · <a href="${escapeHtml(pr.url)}">#${pr.number}</a> · into ${escapeHtml(pr.base)} at <code>${escapeHtml(pr.head.slice(0, 7))}</code> · ${escapeHtml(stamp)} ET</div>
    <p>${escapeHtml(a.body)}</p>
    ${flows}
    <div class="meta sans">${pr.files.length} file${pr.files.length === 1 ? "" : "s"} · +${additions} / −${deletions}</div>
  </div>
  ${figure}
</article>
<footer class="sans">Written by Consort's automatic review of <a href="${escapeHtml(pr.url)}">${escapeHtml(pr.title)}</a>. Approve or decline in the Slack thread.</footer>
</body>
</html>
`;
}

// ── the diagram ───────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<DiagramNodeType, string> = { person: "Person", page: "Page", route: "API route", service: "Service", worker: "Worker", cron: "Cron", queue: "Queue", table: "Table", collection: "Collection", storage: "Bucket / file", external: "External service", infra: "Cloud resource", ci: "CI job" };
const MONO_TYPES = new Set<DiagramNodeType>(["route", "service", "worker", "cron", "queue", "table", "collection"]);
type Look = { fill: string; stroke: string; rx: number; dash?: string };
const LOOK: Record<DiagramNodeType, Look> = {
  person: { fill: "#FFFFFF", stroke: INK, rx: 22 }, page: { fill: "#EEF2FA", stroke: "#3A5A8C", rx: 6 }, route: { fill: "#FFFFFF", stroke: INK, rx: 6 }, service: { fill: "#FFFFFF", stroke: INK, rx: 6 },
  worker: { fill: "#FFFFFF", stroke: INK, rx: 6 }, cron: { fill: "#FFFFFF", stroke: INK, rx: 6 }, queue: { fill: "#EEF3EE", stroke: "#4A7C59", rx: 6 }, table: { fill: "#E8EEF0", stroke: INK, rx: 2 },
  collection: { fill: "#E8EEF0", stroke: INK, rx: 2 }, storage: { fill: "#E8EEF0", stroke: INK, rx: 2 }, external: { fill: "#FBF3E4", stroke: "#8A6D3B", rx: 6, dash: "5 3" }, infra: { fill: "#EEF3EE", stroke: "#4A7C59", rx: 6 }, ci: { fill: "#EEF3EE", stroke: "#4A7C59", rx: 6 },
};
const STATUS_COLOR: Record<Exclude<DiagramStatus, "existing">, string> = { new: "#2F7D4A", changed: "#A06A00", removed: "#B03A2E" };
const COLUMN_MARK: Record<DiagramStatus, string> = { new: "+", changed: "~", removed: "−", existing: " " };
type Placed = DiagramNode & { x: number; y: number; h: number; row: number };

/** Typed boxes laid out top to bottom by dependency, verb-labelled arrows, NEW/CHANGED/REMOVED marks and a legend. */
export function renderDiagram(d: ArticleDiagram): string {
  const placed = layout(d);
  const byId = new Map(placed.map((n) => [n.id, n]));
  const contentW = Math.max(...placed.map((n) => n.x + NODE_W)) + PAD;
  // Arrows that go up or skip a row run down a lane right of the boxes, so they never cross one.
  const laned = d.edges.filter((e) => byId.get(e.to)!.row !== byId.get(e.from)!.row + 1);
  const laneLabelW = Math.max(0, ...laned.map((e) => clip(e.label, EDGE_LABEL_CHARS).length * EDGE_CHAR_W + 14));
  const statuses = DIAGRAM_STATUSES.filter((s): s is Exclude<DiagramStatus, "existing"> => s !== "existing" && (d.nodes.some((n) => n.status === s) || d.nodes.some((n) => n.columns.some((c) => c.status === s))));
  const width = Math.max(contentW + (laned.length ? laned.length * LANE_STEP + laneLabelW : 0), statuses.reduce((w, s) => w + (s === "new" ? 120 : 80), PAD) + PAD);
  const rowBottom: number[] = [];
  for (const n of placed) rowBottom[n.row] = Math.max(rowBottom[n.row] ?? 0, n.y + n.h);
  const bodyH = Math.max(...placed.map((n) => n.y + n.h)) + (laned.length ? GAP_Y / 2 + PAD : PAD);
  const height = bodyH + (statuses.length ? LEGEND_H : 0);
  const edges = d.edges.map((e) => { const lane = laned.indexOf(e); return renderEdge(byId.get(e.from)!, byId.get(e.to)!, e.label, { laned: lane >= 0, laneX: contentW - PAD + (lane + 1) * LANE_STEP, nudge: (lane % 3 - 1) * 5, rowBottom }); });
  let lx = PAD;
  const legend = statuses.map((s) => { const item = `<rect x="${lx}" y="${bodyH + 2}" width="10" height="10" rx="2" fill="none" stroke="${STATUS_COLOR[s]}" stroke-width="2"/><text x="${lx + 15}" y="${bodyH + 11}" font-size="10" fill="${MUTED}">${s === "new" ? "added by this PR" : s}</text>`; lx += s === "new" ? 120 : 80; return item; }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" font-family='${SANS}'>` +
    `<defs><marker id="dd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${MUTED}"/></marker></defs>` +
    edges.map((e) => e.path).join("") + placed.map(renderNode).join("") + edges.map((e) => e.label).join("") + legend + `</svg>`;
}

/** Rows by longest path from the sources, wrapped at MAX_PER_ROW, ordered under their parents; loops break at the edge pointing back up a forward walk. */
function layout(d: ArticleDiagram): Placed[] {
  const back = new Set<DiagramEdge>(), done = new Set<string>(), onPath = new Set<string>();
  const walk = (id: string) => { onPath.add(id); for (const e of d.edges.filter((x) => x.from === id)) { if (onPath.has(e.to)) back.add(e); else if (!done.has(e.to)) walk(e.to); } onPath.delete(id); done.add(id); };
  d.nodes.forEach((n) => done.has(n.id) || walk(n.id));
  const forward = d.edges.filter((e) => !back.has(e));
  const preds = (id: string) => forward.filter((e) => e.to === id).map((e) => e.from);
  const depth = new Map<string, number>();
  const depthOf = (id: string): number => { const known = depth.get(id); if (known !== undefined) return known; const v = Math.max(-1, ...preds(id).map(depthOf)) + 1; depth.set(id, v); return v; };
  d.nodes.forEach((n) => depthOf(n.id));
  const layers: DiagramNode[][] = [];
  for (const n of d.nodes) (layers[depth.get(n.id)!] ??= []).push(n);
  const rows = layers.filter(Boolean).flatMap((l) => Array.from({ length: Math.ceil(l.length / MAX_PER_ROW) }, (_, i) => l.slice(i * MAX_PER_ROW, (i + 1) * MAX_PER_ROW)));
  const widest = Math.max(...rows.map((r) => r.length));
  const rowW = (k: number) => k * NODE_W + (k - 1) * GAP_X;
  const placed = new Map<string, Placed>();
  let y = PAD;
  rows.forEach((row, ri) => {
    const centre = (n: DiagramNode) => { const xs = preds(n.id).map((p) => placed.get(p)).filter((p): p is Placed => !!p).map((p) => p.x); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Infinity; };
    const ordered = [...row].sort((a, b) => centre(a) - centre(b));
    const left = PAD + (rowW(widest) - rowW(ordered.length)) / 2;
    const h = Math.max(...ordered.map(nodeHeight));
    ordered.forEach((n, i) => placed.set(n.id, { ...n, x: left + i * (NODE_W + GAP_X), y, h: nodeHeight(n), row: ri }));
    y += h + GAP_Y;
  });
  return d.nodes.map((n) => placed.get(n.id)!);
}
const nodeHeight = (n: DiagramNode) => HEAD_H + (n.columns.length ? n.columns.length * COL_H + 8 : 0);

function renderNode(n: Placed): string {
  const look = LOOK[n.type];
  const status = n.status === "existing" ? null : STATUS_COLOR[n.status];
  const dash = n.status === "removed" ? "5 3" : look.dash;
  const mono = MONO_TYPES.has(n.type);
  const badge = status ? `<text x="${n.x + NODE_W - 8}" y="${n.y + 15}" text-anchor="end" font-size="9" font-weight="700" letter-spacing=".6" fill="${status}">${n.status.toUpperCase()}</text>` : "";
  const label = `<text x="${n.x + 10}" y="${n.y + 35}" font-size="${mono ? 11 : 12.5}" font-weight="600" fill="${INK}"${mono ? ` font-family='${MONO}'` : ""}${n.status === "removed" ? ` text-decoration="line-through"` : ""}>${escapeHtml(clip(n.label, mono ? MONO_LABEL_CHARS : LABEL_CHARS))}</text>`;
  const cols = n.columns.map((c, i) => { const color = c.status === "existing" ? MUTED : STATUS_COLOR[c.status]; return `<text x="${n.x + 10}" y="${n.y + HEAD_H + 8 + i * COL_H}" font-size="11" font-family='${MONO}' fill="${color}"${c.status === "removed" ? ` text-decoration="line-through"` : ""}>${COLUMN_MARK[c.status]} ${escapeHtml(clip(c.name, MONO_LABEL_CHARS - 2))}</text>`; }).join("");
  const divider = n.columns.length ? `<line x1="${n.x}" y1="${n.y + HEAD_H - 4}" x2="${n.x + NODE_W}" y2="${n.y + HEAD_H - 4}" stroke="${look.stroke}" stroke-opacity=".35"/>` : "";
  return `<g><title>${escapeHtml(`${TYPE_LABEL[n.type]}: ${n.label}`)}</title><rect x="${n.x}" y="${n.y}" width="${NODE_W}" height="${n.h}" rx="${look.rx}" fill="${look.fill}" stroke="${status ?? look.stroke}" stroke-width="${status ? 2 : 1.2}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>` +
    `<text x="${n.x + 10}" y="${n.y + 15}" font-size="9" letter-spacing=".6" fill="${MUTED}">${escapeHtml(TYPE_LABEL[n.type].toUpperCase())}</text>${badge}${label}${divider}${cols}</g>`;
}

type EdgeRoute = { laned: boolean; laneX: number; nudge: number; rowBottom: number[] };
/** Down one row: from the row's bottom, so a short box beside a tall one never draws through it. Otherwise through the gaps between rows and a lane right of every box. */
function renderEdge(a: Placed, b: Placed, text: string, route: EdgeRoute): { path: string; label: string } {
  let d: string, mx: number, my: number, anchor: "middle" | "start" = "middle";
  const ax = a.x + NODE_W / 2, bx = b.x + NODE_W / 2;
  if (route.laned) {
    const gapBelow = (row: number) => route.rowBottom[row]! + GAP_Y / 2 + route.nudge;
    const up = b.row < a.row;
    const [y0, y1] = up ? [a.y, gapBelow(a.row - 1)] : [a.y + a.h, gapBelow(a.row)];
    const [y2, y3] = up ? [gapBelow(b.row), b.y + b.h] : [gapBelow(b.row - 1), b.y];
    d = `M${ax} ${y0} L${ax} ${y1} L${route.laneX} ${y1} L${route.laneX} ${y2} L${bx} ${y2} L${bx} ${y3}`;
    mx = route.laneX + 4; my = (y1 + y2) / 2; anchor = "start";
  } else {
    const rb = route.rowBottom[a.row]!, y2 = b.y, bend = (y2 - rb) / 2;
    d = `M${ax} ${a.y + a.h} L${ax} ${rb} C${ax} ${rb + bend} ${bx} ${y2 - bend} ${bx} ${y2}`;
    mx = (ax + bx) / 2; my = (rb + y2) / 2;
  }
  const path = `<path d="${d}" fill="none" stroke="${MUTED}" stroke-width="1.3" marker-end="url(#dd-arrow)"/>`;
  if (!text) return { path, label: "" };
  const t = clip(text, EDGE_LABEL_CHARS), w = t.length * EDGE_CHAR_W + 10, left = anchor === "start" ? mx - 3 : mx - w / 2;
  return { path, label: `<rect x="${left}" y="${my - 8}" width="${w}" height="15" rx="3" fill="#FFFFFF" fill-opacity=".92"/><text x="${anchor === "start" ? mx + 2 : mx}" y="${my + 3}" text-anchor="${anchor}" font-size="10.5" font-style="italic" fill="${MUTED}">${escapeHtml(t)}</text>` };
}
