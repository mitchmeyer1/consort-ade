import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { EVIDENCE_DIR, EVIDENCE_HEADINGS, EVIDENCE_MANIFEST, stripEvidenceFromDescription, evidenceMarkdownForPr, evidenceTextForTicket, evidenceProblems, parseEvidenceManifest, type EvidenceManifest, type EvidenceTiming, type TaskCost } from "../shared/headless.ts";
import { ticketRef, type ShipTicket } from "../shared/ship.ts";
import type { Source } from "./sources";
import { gateText, PiiWithheldError, type GateContext } from "./phiGate.ts";

/**
 * The evidence step's plumbing: a helper the agent can call for screenshots, terminal images and
 * data diagrams (system Chrome, headless), image hosting for the comments (an orphan `consort-evidence` branch in the PR's own
 * repo, linked through github.com so the images render in the PR, private repos included), and the two comments
 * themselves, each linking to the other. The decisions about what to capture are the agent's
 * (shared/headless.ts EVIDENCE_PROMPT); this file moves bytes.
 */

const run = promisify(execFile);
const gh = async (cwd: string, args: string[]) => (await run("gh", args, { cwd, timeout: 60_000, maxBuffer: 1 << 23 })).stdout;
const git = async (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => (await run("git", args, { cwd, timeout: 120_000, maxBuffer: 1 << 23, env: { ...process.env, ...env } })).stdout.trim();

const CHROME_CANDIDATES = [
  process.env.CONSORT_CHROME ?? "",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome",
];
/** a Chrome or Chromium that can run headless, if the box has one */
export async function findBrowser(): Promise<string | undefined> {
  for (const c of CHROME_CANDIDATES) {
    if (!c) continue;
    if (c.startsWith("/")) { if (existsSync(c)) return c; continue; }
    const found = await run("which", [c]).then((r) => r.stdout.trim(), () => "");
    if (found) return found;
  }
  return undefined;
}

/** the helper script: `node screenshot.cjs <url> [w h]` → PNG path; `node screenshot.cjs --text "<title>" < text > out.png` renders text as a terminal image; `node screenshot.cjs --erd "<title>" < spec.json > out.png` draws a job's steps, tables and relations */
export function writeScreenshotHelper(worktree: string, browser: string): string {
  const dir = join(worktree, ".consort", "tools");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(worktree, EVIDENCE_DIR), { recursive: true });
  const file = join(dir, "screenshot.cjs");
  writeFileSync(file, `#!/usr/bin/env node
// Written by consort-cli. Captures a page with headless Chrome, renders text piped on stdin as a terminal image, or draws a diagram of steps and tables from JSON on stdin.
const { execFileSync } = require("node:child_process");
const { mkdirSync, writeFileSync, readFileSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const BROWSER = ${JSON.stringify(browser)};
const OUT = ${JSON.stringify(join(worktree, EVIDENCE_DIR))};
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
let url, width = 1440, height = 900, out;
// render a page of our own making and write the PNG to stdout
function shoot(html, w, h) {
  const tmp = join(OUT, "." + randomUUID() + ".html");
  const png = join(OUT, "." + randomUUID() + ".png");
  writeFileSync(tmp, html);
  try {
    execFileSync(BROWSER, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-sandbox", "--window-size=" + w + "," + h, "--screenshot=" + png, "file://" + tmp], { stdio: "ignore", timeout: 60000 });
    process.stdout.write(readFileSync(png));
  } finally { try { unlinkSync(tmp); } catch {} try { unlinkSync(png); } catch {} }
}
// a diagram of how a job's data and logic work: its steps in order, the tables it touches, how they relate
function erd(title, spec) {
  const W = 1200, PAD = 24, LH = 20, CARD = 360, GAP = 36, PER_ROW = 3;
  const steps = Array.isArray(spec.steps) ? spec.steps.map(String) : [];
  const tables = (Array.isArray(spec.tables) ? spec.tables : []).filter((t) => t && t.name);
  const relations = (Array.isArray(spec.relations) ? spec.relations : []).filter((r) => r && r.from && r.to);
  const wrap = (s, n) => { const lines = []; let cur = ""; for (const w of String(s).split(" ")) { if (cur && (cur + " " + w).length > n) { lines.push(cur); cur = w; } else cur = cur ? cur + " " + w : w; } if (cur) lines.push(cur); return lines.length ? lines : [""]; };
  const clip = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const parts = [];
  const text = (x, y, s, fill, bold) => parts.push('<text x="' + x + '" y="' + y + '" fill="' + fill + '"' + (bold ? ' font-weight="700"' : "") + ">" + esc(s) + "</text>");
  const heading = (y, s) => text(PAD, y, s.toUpperCase(), "#8a8577", true);
  let y = 76;
  if (steps.length) {
    heading(y, "How it runs"); y += 16;
    steps.forEach((step, n) => {
      const lines = wrap((n + 1) + ". " + step, 140);
      const h = lines.length * LH + 16;
      parts.push('<rect x="' + PAD + '" y="' + y + '" width="' + (W - PAD * 2) + '" height="' + h + '" rx="6" fill="#151515" stroke="#2f2f2f"/>');
      lines.forEach((l, k) => text(PAD + 14, y + 22 + k * LH, l, "#e8e3d6"));
      y += h;
      if (n < steps.length - 1) { parts.push('<path d="M ' + (W / 2) + " " + (y + 2) + " V " + (y + 16) + '" stroke="#9fe8d8" stroke-width="2" marker-end="url(#arrow)"/>'); y += 22; }
    });
    y += 40;
  }
  const at = {};
  if (tables.length) {
    heading(y, "Data it reads and writes"); y += 16;
    for (let r = 0; r < tables.length; r += PER_ROW) {
      const row = tables.slice(r, r + PER_ROW);
      let tallest = 0;
      row.forEach((t, c) => {
        const columns = (Array.isArray(t.columns) ? t.columns : []).map(String);
        const note = t.note ? wrap(t.note, 42) : [];
        const x = PAD + c * (CARD + GAP), h = 34 + note.length * LH + columns.length * LH + 12;
        tallest = Math.max(tallest, h);
        parts.push('<rect x="' + x + '" y="' + y + '" width="' + CARD + '" height="' + h + '" rx="6" fill="#151515" stroke="#3a3a3a"/>');
        parts.push('<path d="M ' + x + " " + (y + 30) + " H " + (x + CARD) + '" stroke="#3a3a3a"/>');
        text(x + 12, y + 20, clip(t.name, 42), "#9fe8d8", true);
        let cy = y + 30;
        note.forEach((l) => { cy += LH; text(x + 12, cy, l, "#8a8577"); });
        const rows = {};
        columns.forEach((col) => { cy += LH; rows[col.split(" ")[0]] = cy - 4; text(x + 12, cy, clip(col, 42), "#e8e3d6"); });
        at[t.name] = { x, y, h, rows };
      });
      y += tallest + 34;
    }
  }
  const ends = (ref) => { const dot = String(ref).lastIndexOf("."); const name = at[ref] || dot < 0 ? String(ref) : String(ref).slice(0, dot); const col = at[ref] || dot < 0 ? "" : String(ref).slice(dot + 1); return { box: at[name], col }; };
  const drawn = [];
  for (const r of relations) {
    const a = ends(r.from), b = ends(r.to);
    if (!a.box || !b.box) continue;
    const ya = a.box.rows[a.col] || a.box.y + 15, yb = b.box.rows[b.col] || b.box.y + 15;
    const right = a.box.x <= b.box.x, same = a.box.x === b.box.x;
    const xa = right ? a.box.x + CARD : a.box.x, xb = same ? b.box.x + CARD + 8 : right ? b.box.x - 8 : b.box.x + CARD + 8;
    const bend = same ? xa + GAP - 6 : (xa + xb) / 2;
    parts.push('<path d="M ' + xa + " " + ya + " C " + bend + " " + ya + ", " + bend + " " + yb + ", " + xb + " " + yb + '" fill="none" stroke="#9fe8d8" stroke-width="1.5" marker-end="url(#arrow)"/>');
    drawn.push(r.from + "  →  " + r.to + (r.label ? "   (" + r.label + ")" : ""));
  }
  if (drawn.length) {
    heading(y, "How the tables relate"); y += 8;
    drawn.forEach((l) => { y += LH; text(PAD, y, clip(l, 146), "#e8e3d6"); });
    y += 30;
  }
  const H = Math.min(8000, Math.max(200, y));
  const html = '<!doctype html><html><body style="margin:0;background:#0b0b0b"><svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" style="font:13px Menlo,Consolas,monospace"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#9fe8d8"/></marker></defs><rect width="' + W + '" height="42" fill="#111"/><path d="M 0 42 H ' + W + '" stroke="#2a2a2a"/>' + '<text x="' + PAD + '" y="27" fill="#9fe8d8" font-weight="700">' + esc(title) + "</text>" + parts.join("") + "</svg></body></html>";
  return { html, width: W, height: H };
}
if (args[0] === "--erd") {
  let spec;
  try { spec = JSON.parse(readFileSync(0, "utf8")); } catch (e) { console.error("--erd reads JSON on stdin: " + e.message); process.exit(2); }
  if (!spec || typeof spec !== "object" || !(Array.isArray(spec.tables) && spec.tables.length) && !(Array.isArray(spec.steps) && spec.steps.length)) { console.error('--erd needs { "steps": [...], "tables": [{ "name", "note", "columns": [...] }], "relations": [{ "from": "table.column", "to": "table.column", "label" }] }'); process.exit(2); }
  const d = erd(args[1] || "How it works", spec);
  shoot(d.html, d.width, d.height);
} else if (args[0] === "--text") {
  const title = args[1] || "output";
  const text = readFileSync(0, "utf8");
  const lines = text.split("\\n").length;
  width = 1000; height = Math.min(4000, Math.max(200, 70 + lines * 20));
  shoot(\`<!doctype html><html><body style="margin:0;background:#0b0b0b;color:#e8e3d6;font:13px/20px Menlo,Consolas,monospace"><div style="padding:10px 16px;border-bottom:1px solid #2a2a2a;color:#9fe8d8">\${esc(title)}</div><pre style="margin:0;padding:14px 16px;white-space:pre-wrap">\${esc(text)}</pre></body></html>\`, width, height);
} else {
  url = args[0];
  if (!url) { console.error("usage: node screenshot.cjs <url> [width height] | --text <title> < file | --erd <title> < spec.json"); process.exit(2); }
  if (args[1]) width = Number(args[1]) || width;
  if (args[2]) height = Number(args[2]) || height;
  out = join(OUT, \`shot-\${randomUUID().slice(0, 8)}.png\`);
  execFileSync(BROWSER, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-sandbox", \`--window-size=\${width},\${height}\`, \`--screenshot=\${out}\`, url], { stdio: "ignore", timeout: 90000 });
  console.log(out);
}
`);
  return file;
}

export function readManifest(worktree: string): EvidenceManifest | undefined {
  try { return parseEvidenceManifest(readFileSync(join(worktree, EVIDENCE_MANIFEST), "utf8")); } catch { return undefined; }
}

/** Reject incomplete manifests and missing/empty captures before any success comment is published. */
export function validateEvidence(worktree: string): EvidenceManifest {
  const manifest = readManifest(worktree);
  const issues = evidenceProblems(manifest);
  if (issues.length) throw new Error(issues.join(" "));
  const dir = realpathSync(join(worktree, EVIDENCE_DIR));
  for (const item of manifest!.items) {
    if (!item.image) continue;
    const file = join(dir, item.image);
    if (!existsSync(file)) throw new Error(`Evidence image is missing: ${item.image}`);
    const path = relative(dir, realpathSync(file));
    if (path.startsWith("..") || isAbsolute(path)) throw new Error("Evidence image must stay inside the evidence directory.");
    if (!statSync(file).isFile() || statSync(file).size === 0) throw new Error(`Evidence image is empty or not a file: ${item.image}`);
  }
  return manifest!;
}

/** upload one file as a ClickUp task attachment; resolves to its public URL */
export async function uploadClickupAttachment(key: string, taskId: string, file: string, type = "image/png"): Promise<string> {
  const form = new FormData();
  form.append("attachment", new Blob([readFileSync(file)], { type }), basename(file));
  const res = await fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(taskId)}/attachment`, { method: "POST", headers: { Authorization: key }, body: form, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickUp attachment: ${res.status} ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  const url = j.url_w_query ?? j.url;
  if (typeof url !== "string") throw new Error("ClickUp returned no attachment url");
  return url;
}

/**
 * Put images on an orphan `consort-evidence` branch, one folder per ticket, without touching the
 * feature branch or the working tree (plumbing only), and return raw URLs. Renders inline on
 * public repos; on private ones the links still open for people with access.
 */
export async function pushEvidenceBranch(repo: string, ticketId: string, files: string[]): Promise<Record<string, string>> {
  const branch = "consort-evidence";
  const remote = await git(repo, ["remote", "get-url", "origin"]).catch(() => "");
  const nameWithOwner = /github\.com[/:]([^/]+\/[^/.]+)/.exec(remote)?.[1] ?? (await gh(repo, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).then((s) => s.trim(), () => "unknown/unknown"));
  await git(repo, ["fetch", "origin", `${branch}:refs/remotes/origin/${branch}`]).catch(() => "");
  const parent = await git(repo, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`]).catch(() => "");
  const index = join(repo, ".git", `consort-evidence-index-${process.pid}`);
  const env = { GIT_INDEX_FILE: index };
  if (parent) await git(repo, ["read-tree", parent], env); else await git(repo, ["read-tree", "--empty"], env);
  const paths: Record<string, string> = {};
  for (const f of files) {
    const blob = await git(repo, ["hash-object", "-w", f]);
    const path = `${ticketId}/${basename(f)}`;
    await git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], env);
    paths[basename(f)] = path;
  }
  const tree = await git(repo, ["write-tree"], env);
  const commit = (await git(repo, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `evidence for ${ticketId}`], env)).trim();
  // --no-verify: this commit holds only images and is never checked out, so a repo's pre-push hook
  // that checks the working tree (or refuses any ref but HEAD) has nothing here to check
  await git(repo, ["push", "--no-verify", "origin", `${commit}:refs/heads/${branch}`]);
  try { (await import("node:fs")).unlinkSync(index); } catch {}
  // github.com links, not raw.githubusercontent.com: GitHub serves them to anyone signed in who can read the repo, so they render in a private repo's PR;
  // pinned to the commit, so a later round that saves a file of the same name never changes an old comment
  const urls: Record<string, string> = {};
  for (const [name, path] of Object.entries(paths)) urls[name] = `https://github.com/${nameWithOwner}/blob/${commit}/${path.split("/").map(encodeURIComponent).join("/")}?raw=true`;
  return urls;
}

/** hidden in the evidence comment so later publishes find the same comment and edit it */
export const EVIDENCE_MARKER = "<!-- consort-evidence -->";

/**
 * Keep ONE evidence comment on the PR: edit ours in place when it exists, post it when it does not,
 * and delete any extra copies older workers left below it. A reader starting at the top of the PR
 * then never meets evidence a later change made wrong. Resolves to the comment's id.
 */
export async function upsertEvidenceComment(repo: string, pr: number, bodyFile: string): Promise<string> {
  const me = (await gh(repo, ["api", "user", "--jq", ".login"]).catch(() => "")).trim();
  // one line per comment, oldest first: id, author, has the marker, opens with the evidence heading
  const listed = await gh(repo, ["api", "--paginate", `repos/{owner}/{repo}/issues/${pr}/comments?per_page=100`, "--jq", `.[] | [.id, .user.login, (.body | contains("${EVIDENCE_MARKER}")), (${EVIDENCE_HEADINGS.map((h) => `(.body | startswith("${h}"))`).join(" or ")})] | @tsv`]);
  const ours = listed.split("\n").map((l) => l.trim().split("\t")).filter(([id, login, marked, heading]) => /^\d+$/.test(id ?? "") && (marked === "true" || (heading === "true" && !!me && login === me))).map(([id]) => id);
  if (!ours.length) {
    const url = await gh(repo, ["pr", "comment", String(pr), "--body-file", bodyFile]);
    return /issuecomment-(\d+)/.exec(url)?.[1] ?? "";
  }
  const [keep, ...extra] = ours;
  await gh(repo, ["api", "-X", "PATCH", `repos/{owner}/{repo}/issues/comments/${keep}`, "-F", `body=@${bodyFile}`]);
  for (const id of extra) await gh(repo, ["api", "-X", "DELETE", `repos/{owner}/{repo}/issues/comments/${id}`]).catch(() => "");
  return keep;
}

const RECEIPT = ".publication.json";

/**
 * The guard against evidence shown twice: take screenshots and evidence sections out of the PR
 * description and leave one line pointing at the evidence comment. Runs after every publish and
 * after every later change, because an agent turn can put them back. Resolves to how many pieces
 * were removed; a failure to read or edit the description resolves to 0, never blocking the task.
 */
export async function guardPrDescription(o: { worktree: string; repo: string; pr: number; prUrl: string }): Promise<number> {
  try {
    let id = "";
    try { id = String(JSON.parse(readFileSync(join(o.worktree, EVIDENCE_DIR, RECEIPT), "utf8")).prCommentId ?? ""); } catch { /* no receipt: link to the PR */ }
    const body = await gh(o.repo, ["pr", "view", String(o.pr), "--json", "body", "--jq", ".body"]);
    const cleaned = stripEvidenceFromDescription(body.replace(/\r\n/g, "\n"), id ? `${o.prUrl}#issuecomment-${id}` : o.prUrl);
    if (!cleaned.removed) return 0;
    const file = join(o.worktree, EVIDENCE_DIR, ".pr-description.md");
    mkdirSync(join(o.worktree, EVIDENCE_DIR), { recursive: true });
    writeFileSync(file, cleaned.body);
    await gh(o.repo, ["pr", "edit", String(o.pr), "--body-file", file]);
    return cleaned.removed;
  } catch { return 0; }
}

export type Published = { items: number; images: number; prComment: boolean; ticketComment: boolean; hosting: "branch" | "none"; /** pieces of duplicated evidence taken out of the PR description */ descriptionCleaned: number };

/**
 * Post the manifest to the PR and the ticket, images hosted where they will render. With the
 * PHI/PII guard on (`gate`), the manifest's text is checked before anything is uploaded or posted,
 * and a finding throws PiiWithheldError; images are not scanned, so EVIDENCE_PROMPT holds them to
 * the seeded local database.
 */
export async function publishEvidence(o: { worktree: string; repo: string; ticket: ShipTicket; pr: number; prUrl: string; source: Source; clickupKey?: string; /** what the task has spent, printed with the evidence */ cost?: TaskCost; timing?: EvidenceTiming; gate?: GateContext; /** the commit the evidence was rechecked against after a later change; printed in the comment */ head?: string }): Promise<Published> {
  const m = validateEvidence(o.worktree);
  const verdict = o.gate ? gateText("evidence", `${evidenceMarkdownForPr(m, {}, o.ticket.url, ticketRef(o.ticket), o.cost, o.timing)}\n\n${evidenceTextForTicket(m, {}, o.prUrl, o.cost, o.timing)}`, o.gate) : undefined;
  if (verdict && !verdict.ok) throw new PiiWithheldError("evidence", verdict.categories);
  const dir = join(o.worktree, EVIDENCE_DIR);
  const wanted = [...new Set(m.items.map((i) => i.image).filter((f): f is string => !!f))].filter((f) => existsSync(join(dir, f)));
  // Save successful transfers so a later network failure does not upload every image again.
  const receiptFile = join(dir, RECEIPT);
  type Receipt = { images: Record<string, { hash: string; url: string }>; pr?: string; prCommentId?: string; ticket?: string; ticketComment?: string };
  let receipt: Receipt = { images: {} };
  const destination = JSON.stringify([o.ticket.source, o.ticket.id, o.prUrl]);
  try {
    const saved = JSON.parse(readFileSync(receiptFile, "utf8"));
    if (saved.destination === destination && saved.images && typeof saved.images === "object") receipt = saved;
  } catch { /* first publication */ }
  const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const saveReceipt = () => writeFileSync(receiptFile, JSON.stringify({ ...receipt, destination }));
  let images: Record<string, string> = {};
  let hosting: Published["hosting"] = "none";
  if (wanted.length) {
    // every image goes to GitHub, never to the ClickUp task: ClickUp attachment links need a ClickUp login, so they show as broken images in the PR
    hosting = "branch";
    const hashes = Object.fromEntries(wanted.map((f) => [f, digest(readFileSync(join(dir, f)))]));
    const fresh = wanted.filter((f) => !(receipt.images[f]?.hash === hashes[f] && receipt.images[f].url.startsWith("https://github.com/")));
    const pushed = fresh.length ? await pushEvidenceBranch(o.repo, o.ticket.id, fresh.map((f) => join(dir, f))) : {};
    for (const f of wanted) {
      images[f] = pushed[f] ?? receipt.images[f].url;
      receipt.images[f] = { hash: hashes[f], url: images[f] };
    }
    saveReceipt();
  }
  if (wanted.some((f) => !images[f])) throw new Error("Evidence image hosting did not return every capture URL.");
  const current = o.head ? `\n\n_Updated after later changes; current as of commit ${o.head.slice(0, 9)}._` : "";
  const prBody = `${evidenceMarkdownForPr(m, images, o.ticket.url, ticketRef(o.ticket), o.cost, o.timing)}${current}\n${EVIDENCE_MARKER}`;
  const bodyFile = join(dir, ".pr-comment.md");
  writeFileSync(bodyFile, prBody);
  let prComment = false, ticketComment = false;
  const prHash = digest(prBody);
  if (receipt.pr !== prHash) {
    receipt.prCommentId = (await upsertEvidenceComment(o.repo, o.pr, bodyFile)) || receipt.prCommentId;
    receipt.pr = prHash;
    saveReceipt();
  }
  prComment = true;
  const ticketBody = evidenceTextForTicket(m, images, o.prUrl, o.cost, o.timing);
  const ticketHash = digest(ticketBody);
  if (receipt.ticket !== ticketHash) {
    // the ticket keeps one evidence comment too: edit the one posted before when the source can
    const edited = !!receipt.ticketComment && !!o.source.editComment && await o.source.editComment(o.ticket.id, receipt.ticketComment, ticketBody).then(() => true, () => false);
    if (!edited) receipt.ticketComment = (await o.source.comment(o.ticket.id, ticketBody)) || undefined;
    receipt.ticket = ticketHash;
    saveReceipt();
  }
  ticketComment = true;
  const descriptionCleaned = await guardPrDescription(o);
  return { items: m.items.length, images: Object.keys(images).length, prComment, ticketComment, hosting, descriptionCleaned };
}

/** every image file the agent left in the evidence folder, for a summary */
export const evidenceFiles = (worktree: string) => { try { return readdirSync(join(worktree, EVIDENCE_DIR)).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f)); } catch { return []; } };
