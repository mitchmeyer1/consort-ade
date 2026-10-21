import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { EVIDENCE_DIR, EVIDENCE_MANIFEST, evidenceMarkdownForPr, evidenceTextForTicket, evidenceProblems, parseEvidenceManifest, type EvidenceManifest, type EvidenceTiming, type TaskCost } from "../shared/headless.ts";
import { ticketRef, type ShipTicket } from "../shared/ship.ts";
import type { Source } from "./sources";

/**
 * The evidence step's plumbing: a screenshot helper the agent can call (system Chrome,
 * headless), image hosting for the comments (ClickUp task attachments when the ticket is a
 * ClickUp task, else an orphan `consort-evidence` branch in the repo), and the two comments
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

/** the helper script: `node screenshot.cjs <url> [w h]` → PNG path; `node screenshot.cjs --text "<title>" < text > out.png` renders text as a terminal image */
export function writeScreenshotHelper(worktree: string, browser: string): string {
  const dir = join(worktree, ".consort", "tools");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(worktree, EVIDENCE_DIR), { recursive: true });
  const file = join(dir, "screenshot.cjs");
  writeFileSync(file, `#!/usr/bin/env node
// Written by consort-cli. Captures a page with headless Chrome, or renders text piped on stdin as a terminal image.
const { execFileSync } = require("node:child_process");
const { mkdirSync, writeFileSync, readFileSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const BROWSER = ${JSON.stringify(browser)};
const OUT = ${JSON.stringify(join(worktree, EVIDENCE_DIR))};
mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
let url, width = 1440, height = 900, out;
if (args[0] === "--text") {
  const title = args[1] || "output";
  const text = readFileSync(0, "utf8");
  const lines = text.split("\\n").length;
  width = 1000; height = Math.min(4000, Math.max(200, 70 + lines * 20));
  const html = \`<!doctype html><html><body style="margin:0;background:#0b0b0b;color:#e8e3d6;font:13px/20px Menlo,Consolas,monospace"><div style="padding:10px 16px;border-bottom:1px solid #2a2a2a;color:#9fe8d8">\${esc(title)}</div><pre style="margin:0;padding:14px 16px;white-space:pre-wrap">\${esc(text)}</pre></body></html>\`;
  const tmp = join(OUT, \`.\${randomUUID()}.html\`);
  writeFileSync(tmp, html);
  url = "file://" + tmp;
  out = join(OUT, \`.\${randomUUID()}.png\`);
  try {
    execFileSync(BROWSER, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-sandbox", \`--window-size=\${width},\${height}\`, \`--screenshot=\${out}\`, url], { stdio: "ignore", timeout: 60000 });
    process.stdout.write(readFileSync(out));
  } finally { try { unlinkSync(tmp); } catch {} try { unlinkSync(out); } catch {} }
} else {
  url = args[0];
  if (!url) { console.error("usage: node screenshot.cjs <url> [width height] | --text <title> < file"); process.exit(2); }
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
  const urls: Record<string, string> = {};
  for (const f of files) {
    const blob = await git(repo, ["hash-object", "-w", f]);
    const path = `${ticketId}/${basename(f)}`;
    await git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], env);
    urls[basename(f)] = `https://raw.githubusercontent.com/${nameWithOwner}/${branch}/${path}`;
  }
  const tree = await git(repo, ["write-tree"], env);
  const commit = await git(repo, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `evidence for ${ticketId}`], env);
  await git(repo, ["push", "origin", `${commit}:refs/heads/${branch}`]);
  try { (await import("node:fs")).unlinkSync(index); } catch {}
  return urls;
}

export type Published = { items: number; images: number; prComment: boolean; ticketComment: boolean; hosting: "clickup" | "branch" | "none" };

/** post the manifest to the PR and the ticket, images hosted where they will render */
export async function publishEvidence(o: { worktree: string; repo: string; ticket: ShipTicket; pr: number; prUrl: string; source: Source; clickupKey?: string; /** what the task has spent, printed with the evidence */ cost?: TaskCost; timing?: EvidenceTiming }): Promise<Published> {
  const m = validateEvidence(o.worktree);
  const dir = join(o.worktree, EVIDENCE_DIR);
  const wanted = [...new Set(m.items.map((i) => i.image).filter((f): f is string => !!f))].filter((f) => existsSync(join(dir, f)));
  let images: Record<string, string> = {};
  let hosting: Published["hosting"] = "none";
  if (wanted.length) {
    if (o.ticket.source === "clickup" && o.clickupKey) {
      hosting = "clickup";
      for (const f of wanted) images[f] = await uploadClickupAttachment(o.clickupKey, o.ticket.id, join(dir, f));
    } else {
      hosting = "branch";
      images = await pushEvidenceBranch(o.repo, o.ticket.id, wanted.map((f) => join(dir, f)));
    }
  }
  if (wanted.some((f) => !images[f])) throw new Error("Evidence image hosting did not return every capture URL.");
  const prBody = evidenceMarkdownForPr(m, images, o.ticket.url, ticketRef(o.ticket), o.cost, o.timing);
  const bodyFile = join(dir, ".pr-comment.md");
  writeFileSync(bodyFile, prBody);
  let prComment = false, ticketComment = false;
  await gh(o.repo, ["pr", "comment", String(o.pr), "--body-file", bodyFile]); prComment = true;
  await o.source.comment(o.ticket.id, evidenceTextForTicket(m, images, o.prUrl, o.cost, o.timing)); ticketComment = true;
  return { items: m.items.length, images: Object.keys(images).length, prComment, ticketComment, hosting };
}

/** every image file the agent left in the evidence folder, for a summary */
export const evidenceFiles = (worktree: string) => { try { return readdirSync(join(worktree, EVIDENCE_DIR)).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f)); } catch { return []; } };
