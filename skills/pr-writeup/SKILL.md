---
name: pr-writeup
description: Produce a reviewer's writeup for a pull request — a Flows map of how the feature is actually used (API endpoints, crons, workers), then verified defects by severity plus the CI reviewer's five categories (Logic, Redundant, Style, Tests, Comments), what is well built, and a suggested order of work. Published as an Artifact from a fixed template. Use when asked to review a PR, write up a PR, or get context on a PR before reviewing it.
user-invocable: true
argument-hint: <pr-number | PR URL | branch | nothing for current branch> [--repo owner/name] [--fanout N]
allowed-tools: Bash Read Grep Glob Agent Artifact Write
effort: high
---

# PR writeup

A document Mitch reads *before* reviewing, that leaves him able to review. Two halves:
**how the feature is used** (Flows) and **what is wrong with it** (verified findings).

Three files in this directory, each with one job:
- `SKILL.md` — the procedure (this file).
- `categories.md` — the agent brief. The nine labels from `scripts/ci/pr-review.ts`
  (🟥 🟧 🟨 🟦 severities · ⛓️ 👯 💅 🧪 📜 categories), their rules, and the false-positive
  traps. Pasted whole into every fan-out agent.
- `template.html` — the **only** stylesheet and section order the document may have.

**Review broadly; write briefly.** Brevity limits the final prose, never the investigation or number of supported findings. Budget per item: ≤60 words a finding, ≤50 a flow,
one short paragraph for the headline. One sentence that lands beats a paragraph that
explains. Twenty real findings earn a long document; two earn a short one. Banned at any
size: filler, hedging, restating the diff, or a second sentence saying what the first
already said.

## Keep the user informed throughout the review

The coordinator owns user-facing progress, including while file agents work. Before the
first tool call, give a one- or two-sentence overview of the behavior being reviewed and
what you will check first. On resume, say what is already finished and what remains.

Send a brief chat update about every **30–45 seconds or five tool calls**, whichever comes
first, and when moving from investigation to verification or writing. Tool rows, shell
output, coverage files, and phase markers do not count as updates. Use short waits (at most
30 seconds when supported) for agents or long-running commands so you can keep reporting.
If a tool blocks longer, give an update as soon as it returns.

In one or two plain-language sentences, explain what you learned, why the current check
matters to someone using the feature, and what remains uncertain or comes next. Describe
behavior and consequences rather than listing commands, filenames, or internal bookkeeping.
For example: “The form saves the new default correctly. I’m checking whether existing
records inherit it or keep their previous selection.” Use examples only when supported by
the actual review; distinguish a suspected issue from a confirmed finding.

When delegating, summarize the review areas and report meaningful results as they arrive.
Use coverage counts only from the ledger; do not invent percentages, findings, or ETAs.
If nothing has resolved yet, name the open question and the evidence still needed rather
than repeating “still working.” Explain delays, failed checks, and their effect on coverage.
Before writing the HTML, summarize the verified findings and remaining limits. Keep the
final operational summary and report link required below. Progress updates do not replace
review work or require user approval to continue.

## Phase 0 — scope

**Resolve the repo first.** Default is the repo of the current working directory. A full PR
URL (`https://github.com/<owner>/<name>/pull/<n>`) or `--repo owner/name` overrides it.
Every `gh pr …` call below then takes `--repo <owner>/<name>`, and every file read, `git`
command and grep runs from that repo's local checkout — look for it at
`~/Work/<name>`; if it isn't there, `gh repo clone <owner>/<name>` into the scratchpad.
Fetch the PR head so `file:line` reads are real:
`git -C <root> fetch origin pull/<n>/head:refs/remotes/origin/pr/<n>`.

```bash
gh pr view <n> --repo <owner>/<name> --json number,title,baseRefName,headRefOid,baseRefOid,state,mergedAt,additions,deletions,changedFiles,body,url
gh pr diff <n> --repo <owner>/<name> --name-only
gh pr diff <n> --repo <owner>/<name>
```

**No PR body, no review.** If `gh` is missing, `git fetch origin
refs/pull/<n>/head:refs/remotes/origin/pr/<n>` gets the code but not the description —
stop and ask Mitch to paste it. The body says what is out of scope and what the follow-up
covers; without it you invent the author's intent and then find fault with the invention.

Review every changed block even for small or exploratory PRs. Respect explicitly deferred scope without overlooking defects in the code that ships. Scale the writeup to the results.

- Pin the **review SHA** (PR head) and base — every `file:line` refers to it. Say so.
- Later commits that invalidate this PR: `git log <base>..origin/<baseRefName> -- <key files>`
  (`development` in aligned-mono, `main` in most other repos — use the PR's `baseRefName`).
- Read the repo's `CLAUDE.md` (and nested ones under the touched packages) if it has one;
  otherwise its README / CONTRIBUTING. Style findings are judged against those, not generic taste.
- Grep coverage once, up front, so agents inherit the evidence instead of guessing, using
  the repo's own test layout (aligned-mono: `tests/ packages/` with `*.test.ts|*.spec.ts`;
  a Python repo: `tests/` with `test_*.py`):
  `grep -rln --include='*.test.ts' --include='*.spec.ts' -E '<NewSymbol|OtherSymbol>' tests/ packages/`.

- Read CI at the start: `gh pr checks <n> --repo <owner>/<name>` and the check runs/status for the pinned head SHA. Record passed, failed, pending, missing, or inaccessible checks and their links. Do not report an older SHA's green checks as current.
- **Do not run tests for this review.** Use CI results as execution evidence. Inspect test code and assertions separately: passing CI does not establish that changed behavior is covered. Pending or inaccessible CI is a stated limitation, not a reason to skip code review.

## Phase 1 — Flows

The spine of the document, and the map every review agent gets. Enumerate every
entrypoint the PR adds or touches, in the repo's own terms. aligned-mono: controllers
(auto-mount at `/api/<namespace>/<filepath>`; name the auth), crons (schedule from
`infra/src/cron.ts`), workers (`<NAME>_JOB`, and who dispatches it), frontend pages,
webhooks in, vendor calls out. A Dagster repo: assets, jobs, schedules, sensors, and the
external systems they read/write. Then trace each by reading the code:

> **Flow N — <name>.** Trigger: who starts it, from where.
> Hops, each with `file.ts:line` — route → service → DB write / dispatch / external call.
> Ends in: the real-world effect. Reachable today: yes / no (name the gate).

Money and data-writing flows first, reads last. Mark which are human-driven and which run
unattended — unattended flows have no reviewer as a backstop. Name the gates. A page, max.

Every defect's "Example flow" must be an instance of one of these.

## Phase 2 — one review agent per changed file

Create a dedicated review agent for **each changed file**. Ten changed files means ten
file agents, not three agents sharing groups of files. The coordinator maps scope,
assigns work, verifies candidates, and writes the report. Use the runtime's agent tool;
`--fanout N` limits concurrent agents, not total agents or coverage. Queue one-file tasks
in waves within the runtime limit, releasing finished agents' slots as needed. Do not
bundle files to fit that limit. If delegation is unavailable, disclose that limitation
and the resulting partial coverage; never claim agents ran when they did not.

Create `.consort/pr-review-coverage.md` before delegation. Pin the head/base SHA and list
every changed file and block (hunk range, affected symbol), its agent/task ID, and status.
Include deleted files, migrations, config, tests, and generated files. For generated or
binary files, the file agent checks the source/generation contract or available metadata
and records inspection limits. For deleted files, trace remaining callers and behavior.

Each file agent reads every changed block, enclosing functions, and relevant before/after
code. It checks **all** of the following for that file:
- Security: authorization, tenant isolation, validation, secrets, sensitive-data handling.
- Logic: inputs, state transitions, reachable paths, guards, errors, and repo architecture.
  Follow callers and callees into other files to verify the actual end-to-end flow.
- Redundancy: search the repository for existing equivalent functions and duplicated logic;
  cite the other definition and verify it can be reused.
- Performance and reliability: queries, bounds, concurrency, retries, idempotency, timeouts,
  and partial failures. Trace caller limits and expected scale.
- Style and comments: compare with repository rules and established peers; identify
  misleading explanations and excess narration.
- Tests: inspect assertions and mocks for changed behavior and error paths. Use pinned-head
  CI as execution evidence; **do not run tests**.

The file boundary keeps assignments focused; it is not a boundary on evidence gathering.
Require a block-by-concern coverage record with evidence or a concrete not-applicable
reason. Agents return candidates and coverage, not HTML. Extend the flow map when their
investigation reveals paths the coordinator missed. A large file may get extra agents for
specific blocks, but retains its primary file owner. Add targeted cross-file or specialist
agents when evidence needs further investigation; these supplement the file agents.

Give **every assignment**: repo/local root, PR number, pinned head/base, assigned file and
exact blocks (or the specific follow-up question), PR body, flow map, relevant repository
instructions, test-search evidence, CI status, and the **entire `categories.md` brief**.
Include its text, not only a path or summary. Require COVERED, DEFECT, ITEM, OPEN, and GOOD
records as applicable. File agents cover every concern above; follow-up agents may focus
on the specific unresolved question they receive.

## Phase 3 — verify and reconcile

Maintain a candidate ledger in `.consort/pr-review-coverage.md`: candidate ID, origin agent,
location, claim, evidence, and disposition. Re-open cited lines at the pinned SHA and trace
callers/guards before deciding. For each candidate record one of:
- **confirmed defect** with reachable trigger and consequence;
- **confirmed category item** with the category's required evidence (no runtime failure needed);
- **duplicate** with a link to the retained candidate;
- **disproved** with the specific guard, caller, assertion, or counterexample that rules it out;
- **open** with the missing evidence and the next concrete check.

Uncertainty is not disproof. Send unresolved candidates back for a bounded verification task,
focused on the missing evidence. In particular, do not discard pagination or query-per-item
concerns without checking bounds, callers, and expected scale. If the needed evidence remains
unavailable, retain the candidate as an Appendix question, not as a verified defect. Never
read production data or PHI to settle a review without the session's required authorization.

A defect must be introduced or worsened by this diff and have a nameable trigger. A category
item need not have a failure scenario: style, redundancy, comments, and test gaps remain
first-class findings. Respect the PR's stated scope, but a follow-up note does not excuse a
current reachable defect. Deduplicate the same root cause, not distinct issues in one file.
Do not impose a finding quota or stop after the first confirmed defect.

Before writing, reconcile every changed file, block, and applicable concern with its file agent’s returned evidence. An unfinished
assignment means partial coverage; reassign it or disclose it. Record agent/task counts,
coverage gaps, CI SHA/status, and unresolved candidates. No tests were run locally: say so.
Zero findings is valid only as a result of completed investigation, never a substitute for it.

## Phase 4 — severity and category

Severity is consequence, for DEFECTS only, and never promotes a non-defect. Use the
definitions in `categories.md` → Severities, restated in the PR's own domain terms in the
"How to read this" legend. ITEMS are unranked; they sit in their category section in
`file` order.

## Phase 5 — the document

Write the report after reconciliation, including when no confirmed findings remain. Use the Appendix for review coverage, CI evidence, and unresolved candidates. **Do not load `artifact-design`** — the design pass is done and
frozen in `template.html`; loading it is where the drift came from.

1. `cp template.html` to the scratchpad and fill every `{{slot}}`. Repeat the blocks marked
   *repeat*; drop only the blocks marked *optional*. Every `<h2>` stays, in template order,
   even when its body is the `None found.` line.
2. **Never edit the `<style>` block, the font link, or the class names.** No new classes,
   no inline styles, no extra sections. If the content does not fit a slot, the content is
   wrong, not the template.
3. Title is `PR <n> · <Short name>` — two to four plain words; prefix the repo name when it
   isn't aligned-mono (`dagster-snowflake PR 193 · Enrollment pingback`). Favicon is always `📋`.
4. In Consort, save `.consort/pr-writeup.html` and link it. Use `Artifact` only when that tool is available. Do not post comments to GitHub unless requested.

Section contract (all present, this order): Header · What it does / What ships today /
Headline · Summary (severity tiles, then category tiles) · How to read this · Flows ·
The pattern worth naming (*optional*) · Defects · ⛓️ Logic · 👯 Redundant · 💅 Style ·
🧪 Tests · 📜 Comments · Appendix · Well built · Order of work.

Each **defect** card: the claim as the heading · `file:line` · **Problem** (1–2 sentences) ·
**Example flow** (1–2 sentences, real values) · **Fix** (the smallest one) · **Ignore if**
(the assumption under which it's fine — mandatory; it's how the author disagrees without
arguing) · **PR comment** — a ready-to-paste GitHub comment in Mitch's voice: ONE sentence,
plain, direct, names the exact file + line to put it on. Model:
> `sigma-md.service.ts:214` — Nothing tests `retry429MaxWaitMs` — add a test that a
> `retry-after: 600` with a small cap resolves fast, so a unit slip here doesn't hang
> the mapping save.

Each **category** card carries only the fields the template gives it (Logic: gap + fix ·
Redundant: overlap + do · Style: house way with peer file + fix · Tests: costs + suite +
the one test · Comments: the trimmed comment). No PR-comment block on category cards.

## Phase 6 — terminal summary and final artifact link

After saving and checking the report, print a concise operational summary in the visible
terminal/chat transcript, even when there are no findings. Derive counts from actual agent
calls and returned coverage, not the plan. Include:
- Reviewed PR and head/base SHA; files and changed blocks covered out of total.
- Actual file-agent count, extra specialist/verification-agent count, total assignments,
  and concurrency/waves used. Distinguish reused agents from new agents and retries.
- One short line per agent: assigned file or question, concerns and cross-file flows checked,
  completion status, and result. List failed, unavailable, or unfinished assignments.
- Confirmed defects by severity, category items, duplicates/disproved candidates, and open
  questions; state any remaining coverage gaps.
- CI status for the reviewed SHA with check links, and “No tests run locally.”

Put the same operational evidence in the report's Appendix. End the response with the
clickable artifact link on its own line, after the summary:
`[PR <n> review](<absolute-worktree-path>/.consort/pr-writeup.html)`.
Use the real saved path (or the actual Artifact URL when available), never a placeholder or
bare path. If report creation failed, state that failure instead of printing a broken link.

## Voice — plain English, not code narration

The reader hasn't read the diff yet. A claim written in the code's own vocabulary
(`claimSend` writes the key at :146, `getState` doesn't select the column) is unreadable
until *after* the review it was supposed to enable. Say what happens to a person or to a
member's data, then point at the code.

**Problem and Example flow are 1–2 sentences each, plain first, refs second.** Lead with
what happens to a person or a member's data in words a new engineer follows with no file
open ("Mono stakes a claim on the member so no one texts them twice"), then the
`file:line`. Never two paragraphs — if the plain sentence needs a code restatement,
the plain sentence wasn't clear enough.

**Headings state the consequence, not the mechanism.** "A missing production secret marks
the member as already-texted, forever, without texting them" beats "the burner number is
read after the idempotency claim". The mechanism goes in Problem; the heading is what the
author would tell someone in the hallway.

**Reach for the plain frame over the precise one when both are true.** Two locks on a
door. A claim staked on a member. A habit, not a lock. These land in one read; "an
availability gate layered on the access control" does not. If a sentence needs a second
read, the frame is wrong, not the reader.

**Example flows use real values, in one breath.** "Admin types 'Zeta Health', hits Enter
inside the debounce, group #1 gets mapped" — names and numbers, no "Flow 3 → Flow 4".
For silent findings, one clause on why nothing looks wrong ("both systems think it's
fine") is usually the most useful words in the finding.

**Category cards are terse by design.** A Comments card is the trimmed comment and nothing
else; a Tests card names the suite and the one assertion. Do not lecture the author about
why brevity or coverage matters — show the better version.

Banned: passive voice hiding the actor, "it should be noted", severity words doing the work
of an explanation ("critically", "dangerously"), and any sentence that only restates the
diff. If the plain paragraph and the code paragraph say the same thing, cut the code one.

## Rules

- Every `file:line` verified at the review SHA. No invented line numbers.
- No ClickUp IDs unless real and in the PR body.
- Findings the author can act on today. No architecture essays.
- Cutting weak findings beats padding the count. If the honest answer is 12, ship 12.
  If it is 0, report 0 with coverage and CI evidence.
- Frozen-behind-a-flag write paths are reviewed as live code.
- The template is law. A writeup that looks different from the last one is a bug.
- Last pass: read the list as the author. Anything that earns "no shit" / "that's a
  follow-up" / "that's just how it works" should have died in Phase 3. Kill it now.
- Same pass, for voice: any claim you can't follow without opening the file isn't finished.
  Agents return findings in code vocabulary — that's their format, not the document's.
  Rewrite every one of them per **Voice** before it ships.
