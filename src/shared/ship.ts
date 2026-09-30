/**
 * /ship: one feature from a ticket to a merged PR through fixed stages. The feature is a
 * worktree: Consort creates the branch, keeps the state on the worktree record, and mirrors
 * the stage onto the ticket (a GitHub issue through `ship:<stage>` labels, a ClickUp task
 * through its status). Each stage runs as a chat in that worktree; the agent reports what
 * happened with markers in its reply, the way it reports plan steps, and Consort applies
 * them. Artifacts (SPEC.md, issues/, TEST-REPORT.md, HANDOFF.md) live in the worktree under
 * .consort/ship/, outside git. Merging is never the pipeline's action.
 */
export const SHIP_STAGES = ["Grilling", "Spec'd", "Implementing", "Ready to Test", "Revising", "In Review", "Merged", "Closed"] as const;
export type ShipStage = (typeof SHIP_STAGES)[number];
export const SHIP_DIR = ".consort/ship";
export const SHIP_DONE: readonly ShipStage[] = ["Merged", "Closed"];

export type ShipSource = "github" | "clickup";
export type ShipTicket = {
  source: ShipSource;
  /** the issue number, or the ClickUp task id */
  id: string;
  url: string;
  title: string;
  /** GitHub: owner/name, from the issue url */
  repo?: string;
};
export type ShipEvent = { at: number; stage: ShipStage; note?: string };
/** the last write of the stage to the ticket; a failed one is retried by main until it lands, `tries` counting the failures in a row */
export type ShipSync = { at: number; ok: boolean; error?: string; note?: string; tries?: number };
/** the wait before retry number n (1-based) of a failed ticket write: 30s, 1m, 2m, 4m, 8m, then every 10 minutes */
export const syncRetryDelay = (n: number) => Math.min(10 * 60_000, 30_000 * 2 ** Math.max(0, n - 1));
export type ShipFeedbackFrom = "user" | "bot" | "teammate";
export type ShipFeature = {
  ticket: ShipTicket;
  slug: string;
  stage: ShipStage;
  paused?: boolean;
  /** the branch is pushed and every ticket is done; the test session comes next */
  built?: boolean;
  /** the agent's own note on what comes next, a /ship command */
  next?: string;
  prs: string[];
  history: ShipEvent[];
  /** worktree-relative paths */
  spec?: string;
  report?: string;
  tests?: { pass: number; total: number };
  feedbackFrom?: ShipFeedbackFrom;
  reviewRound?: number;
  /** the last write of the stage to the ticket */
  sync?: ShipSync;
};

/** what a /ship command asks for */
export type ShipForm = { form: "list" | "new" | "resume" | "feedback" | "approve" | "pr-loop" | "pause"; ref?: string; idea?: string; feedback?: string };
const RESERVED = new Set(["approve", "pr-loop", "pause", "new"]);

export const isShipCommand = (text: string) => /^\/ship(\s|$)/i.test(text.trim());
export const isSlashCommand = (text: string) => /^\/[a-z][\w:-]*(?:\s|$)/i.test(text.trim());

/**
 * `/ship`, `/ship new <idea>`, `/ship [ref] approve|pr-loop|"<feedback>"`, `/ship pause [ref]`.
 * The ref is optional inside a ship worktree, where the feature is known.
 */
export function parseShipCommand(text: string): ShipForm | undefined {
  const t = text.trim();
  const m = /^\/ship(?:\s+([\s\S]*))?$/i.exec(t);
  if (!m) return;
  const rest = (m[1] ?? "").trim();
  if (!rest) return { form: "list" };
  const [first, ...tail] = rest.split(/\s+/);
  const word = first.toLowerCase();
  if (word === "new") { const idea = rest.slice(first.length).trim(); return idea ? { form: "new", idea } : { form: "new" }; }
  if (word === "pause") return { form: "pause", ...(tail[0] ? { ref: tail[0] } : {}) };
  const quoted = /^"([\s\S]*)"$/.exec(rest) ?? /^"([\s\S]*)"$/.exec(rest.slice(first.length).trim());
  if (quoted && rest.startsWith('"')) return { form: "feedback", feedback: quoted[1] };
  const ref = RESERVED.has(word) ? undefined : first;
  const verbRest = ref ? rest.slice(first.length).trim() : rest;
  const verb = verbRest.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (verb === "approve") return { form: "approve", ...(ref ? { ref } : {}) };
  if (verb === "pr-loop") return { form: "pr-loop", ...(ref ? { ref } : {}) };
  if (verb === "pause") return { form: "pause", ...(ref ? { ref } : {}) };
  const fb = /^"([\s\S]*)"$/.exec(verbRest);
  if (fb) return { form: "feedback", feedback: fb[1], ...(ref ? { ref } : {}) };
  if (verbRest && !ref) return { form: "resume" };
  return { form: "resume", ...(ref ? { ref } : {}), ...(verbRest ? { feedback: verbRest } : {}) };
}

/** "/ship approve" → "approve": names the chat after what it was asked to do */
export const shipActionOf = (command: string): string => {
  const f = parseShipCommand(command);
  return !f ? "run" : f.form === "resume" || f.form === "list" ? "next" : f.form;
};

/** a few words of the title, for branch and folder names */
export function shipSlug(title: string, max = 4): string {
  const words = title.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  const stop = new Set(["a", "an", "the", "to", "of", "for", "and", "in", "on", "with", "is", "as", "so", "that", "it"]);
  const kept = words.filter((w) => !stop.has(w));
  return (kept.length ? kept : words).slice(0, max).join("-") || "feature";
}

/** every branch Consort generates gets the prefix from Settings: "mm" + "hris-address-494" → "mm/hris-address-494" */
export function withBranchPrefix(prefix: string | undefined, name: string): string {
  const p = (prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
  return p ? `${p}/${name}` : name;
}
export const shipBranch = (prefix: string | undefined, slug: string, id: string) => withBranchPrefix(prefix, `${slug}-${id.toLowerCase()}`);
export const shipFolder = (slug: string, id: string) => `${slug}-${id.toLowerCase()}`;

/** "Ready to Test" → "ship:ready-to-test"; the GitHub label that carries the stage */
export const stageLabel = (stage: ShipStage) => `ship:${stage.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-")}`;
export const SHIP_LABELS = SHIP_STAGES.map(stageLabel);
export const stageIndex = (stage: ShipStage) => SHIP_STAGES.indexOf(stage);
export const isShipStage = (s: string): s is ShipStage => (SHIP_STAGES as readonly string[]).includes(s);
export const shipDone = (f: Pick<ShipFeature, "stage">) => SHIP_DONE.includes(f.stage);

/** the ticket as the footer names it: #494 for an issue, the task id for ClickUp */
export const ticketRef = (t: ShipTicket) => (t.source === "github" ? `#${t.id}` : t.id);

// the agent's markers: one line each, stripped from the visible reply (see shipPrompt.ts)
export const SHIP_STAGE_MARKER = /\[ship-stage:\s*([^\]|]+?)\s*(?:\|\s*([^\]]*?)\s*)?\]\s*/g;
export const SHIP_BUILT_MARKER = /\[ship-built\]\s*/g;
export const SHIP_PR_MARKER = /\[ship-pr:\s*([^\]]+?)\s*\]\s*/g;
export const SHIP_NEXT_MARKER = /\[ship-next:\s*([^\]]+?)\s*\]\s*/g;
export const SHIP_SPEC_MARKER = /\[ship-spec:\s*([^\]]+?)\s*\]\s*/g;
export const SHIP_REPORT_MARKER = /\[ship-report:\s*([^\]|]+?)\s*(?:\|\s*(\d+)\s*\/\s*(\d+)\s*)?\]\s*/g;
export const SHIP_PAUSE_MARKER = /\[ship-(pause|resume)\]\s*/g;
export const SHIP_FEEDBACK_MARKER = /\[ship-feedback:\s*(user|bot|teammate)\s*\]\s*/g;
export const SHIP_ROUND_MARKER = /\[ship-review-round:\s*(\d+)\s*\]\s*/g;
const ALL_MARKERS = [SHIP_STAGE_MARKER, SHIP_BUILT_MARKER, SHIP_PR_MARKER, SHIP_NEXT_MARKER, SHIP_SPEC_MARKER, SHIP_REPORT_MARKER, SHIP_PAUSE_MARKER, SHIP_FEEDBACK_MARKER, SHIP_ROUND_MARKER];

export type ShipChange = {
  stage?: ShipStage; note?: string; built?: true; prs?: string[]; next?: string; spec?: string; report?: string;
  tests?: { pass: number; total: number }; paused?: boolean; feedbackFrom?: ShipFeedbackFrom; reviewRound?: number;
};

const all = (re: RegExp, text: string) => { re.lastIndex = 0; return [...text.matchAll(re)]; };

/** every ship marker in a reply, folded into one change; the last stage marker wins */
export function parseShipMarkers(text: string): ShipChange | undefined {
  const c: ShipChange = {};
  for (const m of all(SHIP_STAGE_MARKER, text)) {
    const stage = SHIP_STAGES.find((s) => s.toLowerCase() === m[1].trim().toLowerCase());
    if (stage) { c.stage = stage; if (m[2]?.trim()) c.note = m[2].trim(); }
  }
  if (all(SHIP_BUILT_MARKER, text).length) c.built = true;
  const prs = all(SHIP_PR_MARKER, text).map((m) => m[1].trim()).filter((u) => /^https?:\/\//.test(u));
  if (prs.length) c.prs = prs;
  const next = all(SHIP_NEXT_MARKER, text).at(-1)?.[1].trim();
  if (next) c.next = next;
  const spec = all(SHIP_SPEC_MARKER, text).at(-1)?.[1].trim();
  if (spec) c.spec = spec;
  const report = all(SHIP_REPORT_MARKER, text).at(-1);
  if (report) { c.report = report[1].trim(); if (report[2] && report[3]) c.tests = { pass: Number(report[2]), total: Number(report[3]) }; }
  const pause = all(SHIP_PAUSE_MARKER, text).at(-1)?.[1];
  if (pause) c.paused = pause === "pause";
  const from = all(SHIP_FEEDBACK_MARKER, text).at(-1)?.[1] as ShipFeedbackFrom | undefined;
  if (from) c.feedbackFrom = from;
  const round = all(SHIP_ROUND_MARKER, text).at(-1)?.[1];
  if (round) c.reviewRound = Number(round);
  return Object.keys(c).length ? c : undefined;
}

export function stripShipMarkers(text: string): string {
  let out = text;
  for (const re of ALL_MARKERS) { re.lastIndex = 0; out = out.replace(re, ""); }
  return out;
}

/** a new feature record, at the start of the pipeline */
export function newShipFeature(ticket: ShipTicket, slug: string, now: number, stage: ShipStage = "Grilling"): ShipFeature {
  return { ticket, slug, stage, prs: [], history: [{ at: now, stage, note: "Started." }], next: "/ship" };
}

/** the feature after a reply's markers; a stage change is one history event, PRs accumulate once each */
export function applyShipChange(f: ShipFeature, c: ShipChange, now: number): ShipFeature {
  const out: ShipFeature = { ...f, prs: [...f.prs], history: [...f.history] };
  if (c.stage && c.stage !== f.stage) {
    out.stage = c.stage;
    out.history.push({ at: now, stage: c.stage, ...(c.note ? { note: c.note } : {}) });
    if (c.stage === "Revising" || c.stage === "Implementing") out.report = undefined, out.tests = undefined;
    if (c.stage !== "In Review" && c.stage !== "Revising") out.feedbackFrom = undefined;
  } else if (c.note) out.history.push({ at: now, stage: f.stage, note: c.note });
  if (c.built) out.built = true;
  for (const pr of c.prs ?? []) if (!out.prs.includes(pr)) out.prs.push(pr);
  if (c.next) out.next = c.next;
  if (c.spec) out.spec = c.spec;
  if (c.report) { out.report = c.report; out.tests = c.tests; }
  if (c.paused !== undefined) out.paused = c.paused || undefined;
  if (c.feedbackFrom) out.feedbackFrom = c.feedbackFrom;
  if (c.reviewRound !== undefined) out.reviewRound = c.reviewRound;
  return out;
}

/** every /ship reply ends with this line; the agent writes it from the state after its markers */
export const shipFooter = (f: ShipFeature) => `Stage: ${f.stage}${f.paused ? " (paused)" : ""} · Ticket: ${ticketRef(f.ticket)} · Next: ${shipDone(f) ? "none - feature closed" : f.next ?? "/ship"}`;

export type ShipAction = { id: string; label: string; command: string; title?: string; primary?: boolean; ask?: string };

/** the buttons a feature gets at its stage; `ask` actions need text from the user, substituted for {text} */
export function shipActions(f: ShipFeature): ShipAction[] {
  if (shipDone(f)) return [];
  if (f.paused) return [{ id: "resume", label: "Resume", command: "/ship", primary: true }];
  const out: ShipAction[] = [];
  const next = f.next && isShipCommand(f.next) ? f.next.replace(/\s*\([^)]*\)\s*$/, "").trim() : "/ship";
  const label = f.stage === "Grilling" ? "Continue grilling" : f.stage === "Spec'd" ? "Implement" : f.stage === "Implementing" && f.built ? "Run the test session" : f.stage === "Implementing" ? "Continue building" : f.stage === "In Review" ? "Review round" : "Run next step";
  out.push({ id: "next", label, command: next, title: f.next, primary: true });
  if (f.stage === "Ready to Test") out.push({ id: "approve", label: "Approve", command: "/ship approve", title: "Tests pass: mark the PR ready for review" });
  if (f.stage === "In Review" && next !== "/ship pr-loop") out.push({ id: "pr-loop", label: "PR loop", command: "/ship pr-loop", title: "Answer review threads and CI" });
  if (["Implementing", "Ready to Test", "Revising", "In Review"].includes(f.stage)) out.push({ id: "feedback", label: "Feedback…", command: '/ship "{text}"', ask: "Feedback for this feature" });
  out.push({ id: "pause", label: "Pause", command: "/ship pause", title: "Write a handoff so a fresh session can resume cold" });
  return out;
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** fills an `ask` action's {text}, quoted the way the pipeline expects */
export const fillShipCommand = (command: string, text: string) => command.replace('"{text}"', quote(text.trim()));

/**
 * The step inside the stage, where a stage has more than one: Implementing is "building" until the
 * branch is pushed, then the "test session" until the report is written. Undefined where the stage is the step.
 */
export function shipStep(f: ShipFeature): string | undefined {
  if (f.stage === "Implementing") return f.built ? (f.report ? undefined : "test session") : "building";
  return undefined;
}
/** what a running ship chat is doing, for the bar's button while it works: the same words as the step */
export function shipBusyLabel(f: ShipFeature): string {
  const step = shipStep(f);
  if (step) return step === "building" ? "Building…" : "Test session running…";
  return f.stage === "Grilling" ? "Grilling…" : f.stage === "In Review" ? "Review round…" : f.stage === "Revising" ? "Revising…" : "Running…";
}

/** the chat name for a /ship run: "ship · #494 · approve" */
export const shipChatName = (action: string, ticket: ShipTicket) => `ship · ${ticketRef(ticket)} · ${action}`;

/** the name a new-feature chat gets from an idea: its first six words */
export function shipIdeaName(idea: string, max = 6): string {
  const words = idea.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const name = words.slice(0, max).join(" ");
  return words.length > max ? `${name}…` : name;
}

/** the attachment list as the prompt carries it: after a slash command it is part of the skill's arguments */
export const withAttachments = (text: string, files: string[]) => files.length ? `${text}\n\nAttached files (read them from disk):\n${files.map((f) => `- ${f}`).join("\n")}` : text;

/** "https://app.clickup.com/t/86akm7a8g" or a bare id → "86akm7a8g" */
export function clickupIdFrom(text: string): string | undefined {
  const t = text.trim();
  const m = /clickup\.com\/t\/(?:\d+\/)?([A-Za-z0-9-]+)/.exec(t) ?? /^([A-Za-z0-9]{6,12}|[A-Z]+-\d+)$/.exec(t);
  return m?.[1];
}

/** "https://github.com/owner/name/issues/494" → { repo: "owner/name", number: 494 } */
export function githubIssueFrom(text: string): { repo?: string; number: number } | undefined {
  const t = text.trim();
  const url = /github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/.exec(t);
  if (url) return { repo: url[1], number: Number(url[2]) };
  const bare = /^#?(\d+)$/.exec(t);
  return bare ? { number: Number(bare[1]) } : undefined;
}
