import { SHIP_DIR, SHIP_REVIEW_ROUNDS, SHIP_STAGES, TICKET_FILE, shipFooter, shipStep, stageIndex, ticketRef, type ShipFeature, type ShipForm } from "./ship.ts";
import type { ReviewSummary } from "./review.ts";
import { BREAK_CHECK, GRILLING_HEADLESS, HEADLESS_RULES } from "./headless.ts";

/**
 * The prompt for one /ship turn: the rules every stage shares, the feature's state, and the
 * handler for the stage the feature is in (or the form the command asked for). Adapted from
 * an earlier Claude Code skill: the stage machine is the same; the state lives in Consort instead of a
 * state.json and a CLI, the ticket is a GitHub issue or a ClickUp task, and the code lives in
 * the worktree the chat already runs in.
 */
export type ShipPromptInput = {
  feature: ShipFeature;
  form: ShipForm;
  /** absolute path of the feature's worktree, the chat's cwd */
  worktree: string;
  branch: string;
  /** the branch the feature was cut from and the PR targets, e.g. origin/development */
  base: string;
  /** the ticket's body, for grilling */
  ticketBody?: string;
  /** the repo's test and typecheck commands when Consort knows them */
  checks?: string[];
  /** Consort's self-review of the PR: whether its chat is still running, and the review file's counts once written */
  review?: { running: boolean; summary?: ReviewSummary };
  /** consort-cli: no live user; questions go out as [ask-user] markers (see shared/headless.ts) */
  headless?: boolean;
  /** CLI runtime schedules isolated research/writer waves between coordinator turns. */
  runtimeParallel?: boolean;
};

const REVIEW_FILE = (f: ShipFeature) => `.consort/pr-review/pr-${f.review?.pr ?? "<n>"}.review.json`;
/** one line on the self-review for the state block */
function reviewLine(i: ShipPromptInput): string {
  const r = i.feature.review;
  if (!r) return "none yet";
  const s = i.review?.summary;
  const counts = s ? ` · ${s.total} finding(s): ${s.pending} undecided, ${s.queued} approved to post, ${s.commented} on the PR, ${s.ignored} ignored, ${s.fixing} being fixed` : "";
  return `round ${r.round} of ${SHIP_REVIEW_ROUNDS} ${i.review?.running ? "RUNNING now in this worktree (wait for it)" : r.doneAt ? "done" : "started but not finished; Consort restarts it before this step runs again"} · file ${REVIEW_FILE(i.feature)}${counts}`;
}

/** the stage list with the ones behind marked done and the current one marked: "Grilling ✓ → [Spec'd ← you are here] → Implementing → …" */
export function shipStageLine(f: ShipFeature): string {
  const seen = new Set(f.history.map((h) => h.stage));
  return SHIP_STAGES.map((s) => s === f.stage ? `[${s} ← you are here]` : seen.has(s) || stageIndex(s) < stageIndex(f.stage) && s !== "Revising" ? `${s} ✓` : s).join(" → ");
}

const HANDLER_TITLE: Record<string, string> = {
  grilling: "Grilling: interrogate the idea in rounds, then write SPEC.md",
  implementing: "Implementing: tickets from SPEC.md, build them, push, draft PR",
  test: "Test session: prove every story, write TEST-REPORT.md",
  reentry: "Ready to Test: restate where it stands; the user approves or gives feedback",
  approve: "Approve: mark the PR ready; Consort's self-review starts",
  revising: "Revising: gather feedback, explain, apply what the user approves",
  "pr-loop": "In Review: work through Consort's self-review findings, fix, push, next round",
  closeout: "Merged: close out",
  pause: "Pause: write the handoff",
  closed: "Closed: nothing runs",
};

/**
 * The feature's state for someone watching rather than working: the side chat, a summary. Names the stage
 * as N of 8 with the step inside it, so nobody mistakes the turn's 5-phase flow for the pipeline.
 */
export function shipStatusSummary(f: ShipFeature): string {
  const handler = shipHandler(f, { form: "resume" });
  const step = shipStep(f);
  return `This job is one step of Consort's /ship pipeline for ticket ${ticketRef(f.ticket)} "${f.ticket.title}". The pipeline has ${SHIP_STAGES.length} stages; the job's own phase bar (waiting → planning → executing → validating → complete) is the current turn's flow, not the pipeline, so never report it as the ship stage.
- Stages: ${shipStageLine(f)}
- Stage now: ${f.stage} (${stageIndex(f.stage) + 1} of ${SHIP_STAGES.length})${step ? ` · step inside it: ${step}` : ""}${f.paused ? " · PAUSED" : ""}
- What this stage's turn does: ${HANDLER_TITLE[handler] ?? handler}
- Branch pushed and built: ${f.built ? "yes" : "no"} · Spec: ${f.spec ?? "not written"} · Test report: ${f.report ?? "not written"}${f.tests ? ` (${f.tests.pass}/${f.tests.total} stories pass)` : ""} · PRs: ${f.prs.length ? f.prs.join(", ") : "none"}
- Next command on record: ${f.next ?? "/ship"}
- History: ${f.history.slice(-6).map((h) => `${new Date(h.at).toISOString().slice(0, 10)} ${h.stage}${h.note ? `: ${h.note}` : ""}`).join("; ") || "none"}`;
}

/**
 * The short block every plain message in a ship chat carries, so the agent never loses which process it is in,
 * which step it is on, and what the step must produce. The full handler text rides only when the stage moved
 * or the session is fresh; this header points back at it. `turns` is how many turns this chat has taken at
 * the stage, so a repeat does not restart the handler from its first step.
 */
export function shipTurnHeader(f: ShipFeature, turns = 1): string {
  const handler = shipHandler(f, { form: "resume" });
  return `/ship status (read before answering; this chat is one run of Consort's /ship pipeline)
- Feature: ${ticketRef(f.ticket)} "${f.ticket.title}"${f.paused ? " · PAUSED" : ""}
- The ticket's full text (description, status, link) is in ${TICKET_FILE}, written by Consort; read it before answering anything about what the task asks for. You have no tracker access of your own.
- Stages: ${shipStageLine(f)} (stage ${stageIndex(f.stage) + 1} of ${SHIP_STAGES.length}${shipStep(f) ? `, ${shipStep(f)}` : ""})
- This turn's step: ${HANDLER_TITLE[handler] ?? handler}. Its handler text is earlier in this chat; follow it.
- ${turns > 1 ? `This is turn ${turns} of this chat at this stage: do not restart the handler from its first step or re-propose what the transcript already settled; continue from where the transcript stands.` : "First turn at this stage in this chat."}
- Done so far: ${f.history.slice(-4).map((h) => `${h.stage}${h.note ? ` (${h.note})` : ""}`).join("; ") || "nothing"}
- Report every move with the markers ([ship-stage: <stage> | <note>], [ship-next: /ship …], [ship-built], [ship-pr: <url>], [ship-spec: …], [ship-report: …]) and end with the footer line: ${shipFooter(f).replace(/Next: .*$/, "Next: /ship …")}`;
}


const COMMON = (i: ShipPromptInput) => `You are running one step of /ship, Consort's feature pipeline, for the feature below. A feature is in exactly one of these stages, and the stage decides what this turn does:
${shipStageLine(i.feature)}

Consort keeps the feature's state and mirrors the stage onto its ticket (a GitHub issue gets a ship:<stage> label and is closed when merged; a ClickUp task gets the status). You report what happened with markers, each on its own line anywhere in your reply; Consort applies them and strips them from what the user sees:
- [ship-stage: <stage> | <one-line note>] when the feature moves to a stage. Stage names exactly as listed above.
- [ship-built] when every ticket is done and the branch is pushed.
- [ship-pr: <url>] when a pull request exists for this branch.
- [ship-next: /ship …] the command that should run next; Consort shows it as a button. Use the short forms below.
- [ship-spec: ${SHIP_DIR}/SPEC.md] when the spec is written. [ship-report: ${SHIP_DIR}/TEST-REPORT.md | <pass>/<total>] when the test report is written.
- [ship-pause] when a handoff is written; [ship-resume] when resumed. [ship-feedback: user|bot|teammate] when entering Revising.
- [ship-review-round: N] to ask Consort for self-review round N of the PR after fixes are pushed (Consort runs its own pr-writeup review as the next turn of this chat and writes ${SHIP_DIR.replace("ship", "pr-review")}/pr-<n>.review.json; cap ${SHIP_REVIEW_ROUNDS} rounds). Round 1 starts by itself when the feature enters In Review.

Commands the user (and your [ship-next]) use inside this worktree, no ticket id needed: /ship (next step), /ship approve, /ship pr-loop, /ship "<feedback>", /ship pause.

Rules that never bend:
- Work in this worktree only: ${i.worktree}, branch ${i.branch}, cut from ${i.base}. The PR targets ${i.base.replace(/^origin\//, "")}. Never switch branches, never touch another checkout.
- Feature artifacts live under ${SHIP_DIR}/ in this worktree: TICKET.md (the ticket's text, written by Consort each turn; read it rather than asking for the task), SPEC.md, GRILLING.md, issues/NN-slug.md, TEST-REPORT.md, HANDOFF.md, review/. They are never committed; never add ${SHIP_DIR} to git.
- Merging a PR is the user's action. /ship never merges, never force-pushes, never amends a pushed commit.
- Commit in the worktree as you go; a finished ticket is committed before the next one starts.
- Never open PHI-suffixed files or member-level rows, never print .env values.
- A step that asks the user something posts the questions, emits [phase:waiting] and ends the turn. Never answer for the user, even if a host prompt says the user is not watching; the questions are that turn's deliverable.
- Every reply ends with the footer line, written from the state after your markers:
  ${shipFooter(i.feature).replace(/Next: .*$/, "Next: /ship …")}

Feature state now:
- Ticket: ${ticketRef(i.feature.ticket)} "${i.feature.ticket.title}" (${i.feature.ticket.source}) ${i.feature.ticket.url}
- Stage: ${i.feature.stage}${i.feature.paused ? " (paused)" : ""} · built: ${i.feature.built ? "yes" : "no"} · review round: ${i.feature.reviewRound ?? 0}${i.feature.feedbackFrom ? ` · feedback from: ${i.feature.feedbackFrom}` : ""}
- PRs: ${i.feature.prs.length ? i.feature.prs.join(", ") : "none"}
- Spec: ${i.feature.spec ?? "not written"} · Report: ${i.feature.report ?? "none"}${i.feature.tests ? ` (${i.feature.tests.pass}/${i.feature.tests.total} stories pass)` : ""}
- Self-review: ${reviewLine(i)}
- Next step on record: ${i.feature.next ?? "/ship"}
- History: ${i.feature.history.slice(-6).map((h) => `${new Date(h.at).toISOString().slice(0, 10)} ${h.stage}${h.note ? `: ${h.note}` : ""}`).join("; ") || "none"}
${i.checks?.length ? `- Checks this repo runs: ${i.checks.join(" · ")}` : ""}`;

const GRILLING = (i: ShipPromptInput) => `## This turn: Grilling — interrogate the idea to a stopping point, then write the spec

The ticket's text is the idea:
"""
${i.ticketBody?.trim() || i.feature.ticket.title}
"""

Read ${SHIP_DIR}/GRILLING.md first if it exists: it holds the rounds so far; append this round to it. Explore the repo before asking anything a file could answer: facts are your job, decisions are the user's.

Interview the user in rounds. Map the idea as a design tree: every decision branches into the decisions that hang off it. The frontier is every decision whose prerequisites are settled. Ask the whole frontier in one round, numbered, each with your recommended answer:

❓ **Q1** - **<title>**: <question, with the choices when there are some>

➡️ <your recommendation>

Every round ends the turn: post the questions with recommendations, the footer, then [phase:waiting]. The user answers in the next message. Never write the spec in the turn that posed a round.

${BREAK_CHECK} Pose the break question as a numbered question in the round like any other, never buried in prose.

Auto-stop: after the user has answered a round, ask yourself whether every open question has a recommendation the user would accept as written. If yes, and the impact check is recorded, stop and write the spec in that same turn. Hard cap: 3 rounds; in the final round the last question is always "Anything the spec must say that we have not discussed?"

On stop, write ${SHIP_DIR}/SPEC.md by synthesis (no second interview), sections in this order: Problem, Solution, User stories (a long numbered list, "As a <actor>, I want <feature>, so that <benefit>"; the test report later maps to these numbers), Implementation decisions (modules, interfaces, schema, contracts; no file paths or code except a decision-carrying snippet), Testing decisions (what a good test is here, which modules, prior art in the repo), Out of scope, Open questions (only real ones), Impact check, Notes. Use the repo's own vocabulary.
Then emit [ship-spec: ${SHIP_DIR}/SPEC.md] and [ship-stage: Spec'd | Grilled in <n> round(s). Spec written.] and [ship-next: /ship]. Consort posts the spec to the ticket. Print the spec path and the footer.`;

const IMPLEMENTING = (i: ShipPromptInput) => `## This turn: build it, end at "built" (pushed, draft PR, no review yet)

Read ${SHIP_DIR}/SPEC.md. Read a ticket file when building it, repo convention docs when a ticket touches that area; never the whole set up front.

1. Where the build stands. If ${SHIP_DIR}/issues/ has files, their Status lines say it: ${i.runtimeParallel ? 'every ticket "proposed" means a saved breakdown: set its Status to ready-for-agent, emit [ship-stage: Implementing | Tickets ready for runtime scheduling.] and [ship-next: /ship], and END THE TURN before implementation (never re-derive it);' : 'every ticket "proposed" means the breakdown is waiting for the user\'s word, so ask once and briefly whether to go ahead or change it (never re-derive it);'} "ready-for-agent", "in-progress" and "done" plus \`git log --oneline -10\` give the frontier, so build (step 3). Read ${SHIP_DIR}/HANDOFF.md only if it exists.
2. Tickets, only when ${SHIP_DIR}/issues/ is empty. Break SPEC.md into tracer-bullet tickets: each a narrow but complete vertical slice through every layer, demoable on its own, sized for one fresh context, with its blocking edges. Wide mechanical refactors go expand → migrate in batches → contract instead. Write one file per ticket now, ${SHIP_DIR}/issues/NN-<slug>.md, numbered in dependency order:
   # NN: <title> / **What to build:** … / **Blocked by:** none or ticket IDs / **Files:** explicit comma-separated relative files or directories owned by this ticket / **Status:** ${i.runtimeParallel ? "ready-for-agent" : "proposed"} / - [ ] acceptance criteria.
   ${i.runtimeParallel ? `Then write all ticket files with Status: ready-for-agent and their Files and Blocked by fields, emit [ship-stage: Implementing | Tickets ready for runtime scheduling.] and [ship-next: /ship], and END THE TURN before implementation. Consort schedules the independent frontier on the next loop; do not ask for breakdown approval. Ask the owner only for unresolved business-impact decisions, and wait for those answers before marking affected tickets ready.` : `Then present the breakdown as a numbered list (title, blocked by, what it delivers), ask whether the granularity and edges are right, emit [ship-stage: Implementing | Breakdown proposed: <n> tickets.] and [ship-next: /ship], and end the turn with the footer and [phase:waiting] unless the user already approved a breakdown in this chat.
   On the user's go (in this chat): change what they asked, set every Status to ready-for-agent, then build. If the stage is still Spec'd, emit [ship-stage: Implementing | Tickets: <n>.].`}
3. Implement, frontier by frontier: set Status: in-progress, implement, run the repo's typecheck and tests, commit in the worktree, set Status: done. The ticket files plus the git log are the checkpoint a resumed session rebuilds from. Consort CLI can run at most two ready tickets concurrently when their explicit Files scopes do not overlap and neither depends on the other; this also applies within one package. Each writer uses a separate worktree; the coordinator alone integrates commits and runs final typecheck and tests. Never launch concurrent writers on this branch or delegate work without explicit file ownership. Tickets without safe independent scopes stay serial. Reuse .consort/ship/parallel/RESEARCH.md when present; verify relevant files still match before relying on its findings. When a turn ends with tickets still open, say which are done and which are next, and emit [ship-next: /ship].${i.runtimeParallel ? " In this coordinator turn implement at most ONE serial ticket. If any tickets remain after it, emit [ship-next: /ship] and END THE TURN so Consort can schedule the next ready parallel frontier. Never implement a second serial ticket in the same turn." : ""}
4. Built. When the last ticket is done and typecheck and tests are green: push the branch (\`git push -u origin ${i.branch}\`), ${i.feature.prs.length ? `then update the draft PR Consort already opened (${i.feature.prs[0]}) with \`gh pr edit\`: a title without "[WIP]", and a body that summarises what was built and lists the user stories. Do not open another PR` : `open a draft PR against ${i.base.replace(/^origin\//, "")} with \`gh pr create --draft\` whose body summarises what was built and lists the user stories`} (mention the ticket: "Closes ${i.feature.ticket.source === "github" ? `#${i.feature.ticket.id}` : i.feature.ticket.url}" for GitHub), then emit [ship-built], [ship-pr: ${i.feature.prs[0] ?? "<url>"}] and [ship-next: /ship]. Print three lines: what was built, the branch and HEAD sha, and that the test session runs next. Stop; do not run the test session in this turn.`;

const TEST_SESSION = (i: ShipPromptInput) => `## This turn: the test session — prove every story, write the report, hand it to the user

The build is pushed. In this order:
1. Bring the app up the way this repo does (its README, package scripts or compose files); if it cannot run here, say so and verify by tests and code reading instead.
2. Checks: run the repo's test suite and typecheck${i.checks?.length ? ` (${i.checks.join(", ")})` : ""}. A failure that is a bug in the build: fix, commit, push, rerun.
3. Self-review the diff against ${i.base} on two axes, kept separate: Standards (does the code follow this repo's documented conventions and avoid the usual smells: mysterious names, duplication, feature envy, speculative generality) and Spec (does it do what SPEC.md asks, nothing missing, nothing extra). Fix blockers and high findings, commit, push; list medium and low in the report.
4. Verify each numbered user story in SPEC.md: exercise it for real where you can (the running app, the screenshot helper for anything visual, the CLI or endpoint), otherwise by the tests that cover it. Record PASS or FAIL with a plain-words account the user can read, and evidence (a screenshot path, a command and its output).
5. Write ${SHIP_DIR}/TEST-REPORT.md: a summary line, a table of stories (number, title, PASS/FAIL, how verified, evidence), the self-review findings kept as notes, and what to look at by hand. Emit [ship-report: ${SHIP_DIR}/TEST-REPORT.md | <pass>/<total>], [ship-stage: Ready to Test | <pass>/<total> stories pass.] and [ship-next: /ship approve].
6. Print the summary, the report path as a clickable link, and the two commands: /ship approve, /ship "<feedback>". Footer. Stop.`;

const REENTRY = (i: ShipPromptInput) => `## This turn: Ready to Test — restate where it stands

Nothing runs. Read ${SHIP_DIR}/TEST-REPORT.md and print its summary block, the report path as a link, the PR link${i.feature.prs.length ? ` (${i.feature.prs[0]})` : ""}, and the two commands: /ship approve, /ship "<feedback>". Emit [ship-next: /ship approve]. Footer.`;

const APPROVE = (i: ShipPromptInput) => `## This turn: approve — the tests are blessed, put the PR up and hand it to Consort's self-review

1. Confirm the branch is pushed and the draft PR exists${i.feature.prs.length ? ` (${i.feature.prs[0]})` : " (create one with gh pr create --draft against " + i.base.replace(/^origin\//, "") + " if it does not)"}. Update the PR body from ${SHIP_DIR}/TEST-REPORT.md: what was built, the verified stories table, follow-ups.
2. \`gh pr ready <url>\`. Do not trigger any reviewer and do not review the PR yourself: the moment the stage moves, Consort queues its own AI self-review (the pr-writeup review) of this PR as the next turn of this very chat, and the step after that reads its findings. End your turn promptly so it can start.
3. Emit [ship-pr: <url>], [ship-stage: In Review | PR ready; self-review round 1 starts.] and [ship-next: /ship pr-loop]. Print the PR link, one line saying the self-review is starting and that /ship pr-loop runs when it is done, and the footer.`;

const REVISING = (i: ShipPromptInput, from: "user" | "bot" | "teammate", feedback?: string) => `## This turn: Revising — gather, explain, then apply what the user approves

Feedback came from: ${from}.${feedback ? `\nThe user's feedback:\n"""\n${feedback}\n"""` : ""}

Motion 1, no code changes yet. Collect every item: the feedback above; comments on the ticket newer than the last stage change; unresolved PR review threads for each PR (\`gh api graphql\` on reviewThreads, keeping isResolved false); findings in ${REVIEW_FILE(i.feature)} that are not ignored, when a self-review has run. If the stage is not yet Revising emit [ship-stage: Revising | <n> item(s) gathered.] and [ship-feedback: ${from}]. Then, numbered, for each item: what was asked, what it would change, your recommendation (accept, dismiss with reason, or modify). End with the footer and [phase:waiting]. The user rules per item.

Motion 2, once the user has ruled (in this chat): apply the approved items in the worktree; typecheck and test; commit and push as stacked commits. Re-verify the stories the items touched and append a "## Round N" section to ${SHIP_DIR}/TEST-REPORT.md (emit [ship-report: ${SHIP_DIR}/TEST-REPORT.md | <pass>/<total>]). For PR threads: reply on each with what was done or why not, and resolve the ones addressed; never re-request review or merge on the user's behalf. Comment on the ticket with what changed and what was dismissed.
Return: feedback from the user → [ship-stage: Ready to Test | <what changed>] and [ship-next: /ship approve]; from a bot or teammate → [ship-stage: In Review | <what changed>] and [ship-next: /ship pr-loop] (Consort starts a fresh self-review round of the new head). Footer.`;

const PR_LOOP = (i: ShipPromptInput) => `## This turn: In Review — work through one round of Consort's self-review of the PR

The reviewer is Consort's own pr-writeup review, run by Consort as an earlier turn of this chat (or of another ship chat of this worktree); it writes ${REVIEW_FILE(i.feature)} (schema: findings[] with id, kind, severity, category, title, file, line, problem, fix, comment, status). The user rules on findings in Consort's review drawer: status "ignored" is the user's decision, skip it; "approved" or "commented" means the user wants it on the PR; "fixing" means it was handed to a chat to fix (maybe this one); "pending" is undecided. Never edit that file and never post review comments yourself.

1. For each PR${i.feature.prs.length ? ` (${i.feature.prs.join(", ")})` : ""}: \`gh pr view <url> --json state,mergedAt,isDraft,reviewDecision\`. Merged → follow the closeout below instead. Closed unmerged → say so and stop.
2. Where the self-review stands (state block above). Running → say so, emit [ship-next: /ship pr-loop] and stop; Consort runs this step again when it finishes. No round started and none running → emit [ship-review-round: ${(i.feature.reviewRound ?? 0) + 1}] and stop. Done → read the file, plus teammate PR threads (\`gh api graphql\` reviewThreads with isResolved false) and CI (\`gh pr checks\`). Save a digest to ${SHIP_DIR}/review/round-${i.feature.review?.round ?? (i.feature.reviewRound ?? 0) + 1}.md.
3. Adjudicate each finding that is not ignored against the code before writing to the user: confirmed (fix it), refuted (say why), incomplete (fix the true half, list the rest as a follow-up in the PR body). Present one numbered batch: finding id and title, verdict, one-line evidence, planned action. Teammate threads go in a separate short list marked "yours to answer" with a proposed reply. End with the footer and [phase:waiting] for the user's go, unless the user already gave it in this chat.
4. On go: fix as stacked commits, typecheck and test, push. Reply on every PR thread you acted on and resolve the ones now addressed; a teammate thread the user has not ruled on stays open. Then, if this was round ${SHIP_REVIEW_ROUNDS} or you changed nothing, emit [ship-next: /ship pr-loop] and stop; otherwise emit [ship-review-round: ${(i.feature.review?.round ?? i.feature.reviewRound ?? 0) + 1}] and [ship-next: /ship pr-loop] and stop: Consort reviews the new head and runs this step again.
5. Nothing left (every finding ignored, refuted, fixed or on the PR; CI green): say what remains open (follow-ups, teammate threads) and that merging is the user's. Emit [ship-next: /ship] (the next /ship confirms the merge). Footer.

## Closeout, when the PR is merged
1. Confirm with \`gh pr view <url> --json mergedAt,mergeCommit\`. Emit [ship-stage: Merged | Merged <sha> into <base>.]; Consort closes the ticket.
2. If this feature taught something durable (a repo convention, a gotcha, a decision), write one memory file and index it; if nothing, say so.
3. Final comment on the ticket: what shipped, PR links. Emit [ship-stage: Closed | Closed.] and [ship-next: none]. Say the worktree can now be removed from Consort's sidebar. Footer.`;

const CLOSEOUT = (i: ShipPromptInput) => `## This turn: Merged → Closed

1. Confirm the merge: \`gh pr view ${i.feature.prs[0] ?? "<url>"} --json mergedAt,mergeCommit\`. If it is not merged, say so, emit [ship-stage: In Review | Not merged yet.] and stop.
2. If this feature taught something durable (a repo convention, a gotcha, a decision), write one memory file and index it; if nothing, say so.
3. Final comment on the ticket: what shipped, PR links. Emit [ship-stage: Closed | Closed.] and [ship-next: none]. Say the worktree can now be removed from Consort's sidebar. Footer.`;

const PAUSE = (i: ShipPromptInput) => `## This turn: pause — write a handoff a fresh session can resume from cold

Gather live state, never guess: \`git branch --show-current\`, \`git log --oneline -8\`, \`git status --short\`; for each PR \`gh pr view <url> --json url,isDraft,mergeable,mergeStateStatus,reviewDecision\` and \`gh pr checks <url>\`; unresolved review threads; the ticket's latest comments.
Write ${SHIP_DIR}/HANDOFF.md with these sections in order: One-line status; Where things stand (committed/pushed, PR and CI, what is verified); Immediate next steps and blockers; Ticket link and status; Key decisions already made, with the why; Conventions and gotchas; Memory pointers; Branch, worktree, ports; Suggested next command. Separate DONE / IN-FLIGHT / BLOCKED. Real SHAs, PR numbers, paths. Redact secrets. Point to SPEC.md, issues/ and commits rather than repeating them.
Persist anything durable to memory first. Post the handoff as a comment on the ticket. Emit [ship-pause] and [ship-next: /ship]. Footer.`;

const RESUME_PAUSED = (i: ShipPromptInput) => `## First: this feature is paused

Read ${SHIP_DIR}/HANDOFF.md and restate it in three lines. Emit [ship-resume]. Then continue with the stage handler below.\n\n`;

const CLOSED = () => `## This feature is closed

Say so, point at the PRs and the report, and stop. Footer: Stage: Closed · Ticket: … · Next: none - feature closed`;

/** which handler this turn runs, from the stage and what the command asked for */
/** the user pressed Redo on a finished stage: Consort has already rewound the feature; the handler below runs the stage again */
const REDO = (stage: string) => `## Redo: ${stage}

The user asked for the ${stage} stage to be done again. Consort has rewound the feature to it; the earlier output of this stage is still on disk under ${SHIP_DIR}/ so you can read it, but do the stage again properly rather than confirming what is there, and say in one line what changed from last time.${stage === "Spec'd" || stage === "Implementing" ? ` For the ticket breakdown: move the old ${SHIP_DIR}/issues/ aside to ${SHIP_DIR}/issues.previous/ and derive the tickets afresh from SPEC.md; a ticket whose work is already committed on the branch is written with Status: done.` : ""}${stage === "Grilling" ? " Treat SPEC.md as a draft to improve, not as settled." : ""}`;

export function shipHandler(f: ShipFeature, form: ShipForm): string {
  if (form.form === "pause") return "pause";
  if (f.stage === "Closed") return "closed";
  if (form.form === "feedback") return "revising";
  if (f.stage === "Grilling") return "grilling";
  if (f.stage === "Spec'd" || (f.stage === "Implementing" && !f.built)) return "implementing";
  if (f.stage === "Implementing" && f.built && !f.report) return "test";
  if (f.stage === "Implementing") return "reentry";
  if (f.stage === "Ready to Test") return form.form === "approve" ? "approve" : "reentry";
  if (f.stage === "Revising") return "revising";
  if (f.stage === "In Review") return "pr-loop";
  if (f.stage === "Merged") return "closeout";
  return "reentry";
}

export function shipPrompt(i: ShipPromptInput): string {
  const handler = shipHandler(i.feature, i.form);
  const body =
    handler === "pause" ? PAUSE(i)
    : handler === "closed" ? CLOSED()
    : handler === "grilling" ? (i.headless ? GRILLING_HEADLESS : GRILLING(i))
    : handler === "implementing" ? IMPLEMENTING(i)
    : handler === "test" ? TEST_SESSION(i)
    : handler === "approve" ? APPROVE(i)
    : handler === "revising" ? REVISING(i, i.form.form === "feedback" ? "user" : i.feature.feedbackFrom ?? "user", i.form.feedback)
    : handler === "pr-loop" ? PR_LOOP(i)
    : handler === "closeout" ? CLOSEOUT(i)
    : REENTRY(i);
  const paused = i.feature.paused && handler !== "pause" && handler !== "closed" ? RESUME_PAUSED(i) : "";
  const redo = i.form.form === "redo" && i.form.stage ? `${REDO(i.form.stage)}\n\n` : "";
  const headless = i.headless ? `${HEADLESS_RULES}\n\n` : "";
  return `${COMMON(i)}\n\n${headless}${paused}${redo}${body}`;
}
