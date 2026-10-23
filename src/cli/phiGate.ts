import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { categoryLine, piiSpans, redactSpans, scanPii, shapeLine, type Posture } from "../shared/piiGate.ts";
import { phiSettings, type PhiSettings } from "../shared/phi.ts";
import { redactPii } from "../shared/redact.ts";
import { PUSH_DENY } from "../shared/egress.ts";
import { loadState, PHI_INCIDENTS } from "./state.ts";
import type { Source } from "./sources";

/**
 * The PII gate at the doors an uncovered context has to the outside, with the PHI/PII guard on.
 * Outbound text (Slack, ticket comments and descriptions, PR bodies and comments, reviews,
 * evidence) passes `gateText` in the release posture: on a block finding nothing is sent and the
 * caller says so. A push passes `pushFindings` over its commit messages and added lines in the
 * commit posture, so published placeholders get through. Inbound text (the ticket, the owner's
 * answers, review comments, Sentry reports) is masked by `inbound` before an agent sees it. A
 * high-precision finding is an incident: a JSON line in PHI_INCIDENTS, with categories and
 * masked shapes but never the text, and a line to the owner. With the guard off, everything here
 * lets text through untouched.
 */

export type Incident = { ts: string; op: string; task?: string; ticket?: string; categories: string; shapes: string };
export type GateContext = { phi: PhiSettings; task?: string; ticket?: string; /** one line to the owner, categories only */ alert?: (line: string) => unknown; record?: (incident: Incident) => void };
export type Verdict = { ok: true } | { ok: false; categories: string; shapes: string };
export type Git = (args: string[], cwd: string) => Promise<string>;
/** run before a push: undefined to go ahead, else the line that says what was withheld */
export type PushGuard = (git: Git, cwd: string) => Promise<string | undefined>;

export class PiiWithheldError extends Error {
  readonly op: string;
  readonly categories: string;
  constructor(op: string, categories: string) {
    super(`${op} withheld by the PII gate (${categories}); nothing was sent`);
    this.name = "PiiWithheldError";
    this.op = op;
    this.categories = categories;
  }
}

export function gateText(op: string, text: string, c: GateContext, posture: Posture = "release"): Verdict {
  if (!c.phi.guard || !text) return { ok: true };
  const scan = scanPii(text, posture, c.phi);
  if (scan.clean) return { ok: true };
  const verdict = { ok: false as const, categories: categoryLine(scan), shapes: shapeLine(scan) };
  if (scan.highPrecision) incident(op, verdict, c);
  return verdict;
}

const IMAGES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
export const UNSCANNABLE: Verdict = { ok: false, categories: "a file the gate cannot read", shapes: "" };
/** a file about to leave: text is scanned, an image passes, anything else cannot be read and is withheld */
export function gateFile(op: string, path: string, c: GateContext, read: (path: string) => Buffer = readFileSync): Verdict {
  if (!c.phi.guard || IMAGES.has(extname(path).toLowerCase())) return { ok: true };
  let bytes: Buffer;
  try { bytes = read(path); } catch { return UNSCANNABLE; }
  if (bytes.length > 20 * 1024 * 1024 || bytes.subarray(0, 8000).includes(0)) return UNSCANNABLE;
  return gateText(op, bytes.toString("utf8"), c);
}

/** text an agent is about to read, with every identifier the gate knows masked as [REDACTED:<category>] */
export function inbound(text: string, phi: PhiSettings): { text: string; masked: number } {
  if (!phi.guard || !text) return { text, masked: 0 };
  const spans = piiSpans(text, "release", phi).filter((s) => s.tier === "block");
  return { text: redactSpans(text, spans), masked: spans.length };
}

/** what Slack carries: a notice in place of a message the gate withholds, else the message with names and identifiers masked */
export function slackText(text: string, c: GateContext): string {
  // the notice is the owner's alert: the thread is where they would have read the message
  const verdict = gateText("Slack message", text, { ...c, alert: undefined });
  return verdict.ok ? redactPii(text) : `⚠️ Message withheld by the PII gate (${verdict.categories}).`;
}
/** Slack's gate for a process with no task context: the guard's settings as state holds them at each call */
export const slackGate = (text: string) => slackText(text, { phi: phiSettings(loadState()) });

/** the ticket source, with every comment, description and attachment gated; a withheld one throws PiiWithheldError */
export function gatedSource(source: Source, c: GateContext): Source {
  if (!c.phi.guard) return source;
  const pass = (op: string, verdict: Verdict) => { if (!verdict.ok) throw new PiiWithheldError(op, verdict.categories); };
  return {
    ...source,
    comment: async (id, text) => { pass("ticket comment", gateText("ticket comment", text, c)); return source.comment(id, text); },
    updateBody: async (id, body) => { pass("ticket description", gateText("ticket description", body, c)); return source.updateBody(id, body); },
    attach: async (id, file) => { pass("ticket attachment", gateFile("ticket attachment", file, c)); return source.attach(id, file); },
  };
}

// lockfiles hold hashes and versions, never people, and are long enough to cost every push a scan
const LOCKFILE = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/;

/**
 * What a push would send that the commit posture blocks, as `path:line category` for each added
 * line and `commit message: category` for each message, commit by commit over `revisions` (git
 * log's: `base..HEAD`, or a push's sources `--not --remotes`): a line one commit adds and a later
 * one removes still travels in the history. Merge commits are skipped, so merging the base in
 * brings none of the base's own lines.
 */
export async function pushFindings(git: Git, cwd: string, revisions: string[], c: GateContext): Promise<string[]> {
  if (!c.phi.guard) return [];
  const findings = new Set<string>(), categories = new Set<string>(), shapes: string[] = [];
  let highPrecision = false;
  const scan = (text: string, where: string) => {
    const found = scanPii(text, "commit", c.phi);
    if (found.clean) return;
    findings.add(`${where} ${categoryLine(found)}`);
    for (const f of found.findings) if (f.tier === "block") categories.add(f.category);
    shapes.push(shapeLine(found));
    highPrecision ||= found.highPrecision;
  };
  const log = await git(["log", "--reverse", "--no-merges", "--patch", "--unified=0", "--no-color", "--no-ext-diff", "--format=%x01%B%x02", ...revisions], cwd);
  for (const commit of log.split("\x01").slice(1)) {
    const [message, patch = ""] = commit.split("\x02");
    scan(message, "commit message:");
    for (const file of addedLines(patch)) if (!LOCKFILE.test(file.path)) for (const line of file.lines) scan(line.text, `${file.path}:${line.number}`);
  }
  if (highPrecision) incident("push", { categories: [...categories].join(", "), shapes: shapes.join(" ") }, c);
  return [...findings];
}

/** a PushGuard over the commits after `base`; none with the guard off */
export const pushGuard = (base: string, c: GateContext): PushGuard | undefined => !c.phi.guard ? undefined : async (git, cwd) => {
  const found = await pushFindings(git, cwd, [`${base}..HEAD`], c);
  return found.length ? PUSH_DENY(found) : undefined;
};

/** the incident log's latest entries, oldest first */
export function readIncidents(last: number, file = PHI_INCIDENTS): Incident[] {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  return text.split("\n").filter(Boolean).slice(-last).flatMap((line) => { try { return [JSON.parse(line) as Incident]; } catch { return []; } });
}

export function incident(op: string, found: { categories: string; shapes: string }, c: GateContext, outcome = "Withheld; nothing was sent."): void {
  const entry: Incident = { ts: new Date().toISOString(), op, ...(c.task ? { task: c.task } : {}), ...(c.ticket ? { ticket: c.ticket } : {}), categories: found.categories, shapes: found.shapes };
  try { (c.record ?? appendIncident)(entry); } catch { /* the gate's decision stands whether or not the log is writable */ }
  const contact = c.phi.complianceContact;
  void Promise.resolve().then(() => c.alert?.(`⚠️ PII gate: ${op} carried ${found.categories}. ${outcome} Logged to phi-incidents.jsonl.${contact ? ` Compliance contact: ${contact}.` : ""}`)).catch(() => undefined);
}

function appendIncident(entry: Incident): void {
  mkdirSync(dirname(PHI_INCIDENTS), { recursive: true });
  appendFileSync(PHI_INCIDENTS, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** the lines a unified diff adds, by file, with their numbers in the new file */
function addedLines(diff: string): { path: string; lines: { number: number; text: string }[] }[] {
  const files: { path: string; lines: { number: number; text: string }[] }[] = [];
  let header = false, next = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { header = true; continue; }
    if (header && line.startsWith("+++ ")) { files.push({ path: line.slice(4).replace(/^"?b\//, "").replace(/"$/, ""), lines: [] }); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { header = false; next = Number(hunk[1]); continue; }
    if (!header && line.startsWith("+") && files.length) files.at(-1)!.lines.push({ number: next++, text: line.slice(1) });
  }
  return files;
}
