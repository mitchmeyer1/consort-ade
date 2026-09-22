---
name: pr-writeup
description: Produce a reviewer's writeup for a pull request — a Flows map of how the feature is actually used (API endpoints, crons, workers), then verified defects by severity plus the CI reviewer's five categories (Logic, Redundant, Style, Tests, Comments), what is well built, and a suggested order of work. Written as a `pr-<n>.review.json` that Consort renders live, with a Comment-on-PR / Ignore decision per finding. Use when asked to review a PR, write up a PR, or get context on a PR before reviewing it.
user-invocable: true
argument-hint: <pr-number | PR URL | branch | nothing for current branch> [--repo owner/name] [--fanout N]
allowed-tools: Bash Read Grep Glob Agent Write
effort: high
---

# PR writeup

A document Mitch reads *before* reviewing, that leaves him able to review. Two halves:
**how the feature is used** (Flows) and **what is wrong with it** (verified findings).

Two files in this directory, each with one job:
- `SKILL.md` — the procedure (this file), including the review-file schema in Phase 5.
- `categories.md` — the agent brief. The nine labels from `scripts/ci/pr-review.ts`
  (🟥 🟧 🟨 🟦 severities · ⛓️ 👯 💅 🧪 📜 categories), their rules, and the false-positive
  traps. The runtime copies it to `.consort/pr-review/categories.md`; agents read it there.

The deliverable is **data, not a page**: `.consort/pr-review/pr-<n>.review.json`. Consort
renders it as the writeup, with a *Comment on PR* / *Ignore* decision on every finding and one
button that posts the approved comments to GitHub as a single review. Never post to GitHub
yourself; that step is Mitch's.

**Review broadly; write briefly.** Brevity limits the final prose, never the investigation or
number of supported findings. Budget per item: ≤60 words a finding, ≤50 a flow, one short
paragraph for the headline. One sentence that lands beats a paragraph that explains. Twenty
real findings earn a long document; two earn a short one. Banned at any size: filler,
hedging, restating the diff, or a second sentence saying what the first already said.

## Model tiers — you orchestrate, agents read

You run on the session's strongest model; the agents you dispatch run one tier down. That
split is the budget. A review's tokens go overwhelmingly into reading files, grepping for
peers and tracing callers, and none of that needs your model.

**Your tokens buy judgement, not pages.** Yours go to scope, grouping the files, writing
short assignments, ruling on returned candidates, and the document. The agents' tokens buy
the reading.

- Dispatch every agent at the delegate tier; pass the model on the call.
- Do not walk the diff file by file yourself. You read the PR body, the `--name-only`
  list, CI, and the repo's instructions — the code gets read by agents.
- Opening specific cited lines in Phase 3 to settle a candidate is yours to do: named
  lines, not a file sweep.
- Escalate one agent to your tier only after a delegate-tier agent has actually failed on
  a specific question. Say so in the summary.

## Three runtime rules that decide the cost of a review

1. **Agents run to completion, never in the background.** Pass `run_in_background: false`
   on every `Agent` call and dispatch a whole wave in one message so they run concurrently.
   In this runtime a turn that ends with agents still running loses their results, and the
   next turn pays to dispatch them all again. Do not "check back later" on an agent.
2. **Shared context lives in one file, not in every prompt.** Write
   `.consort/pr-review/brief.md` once (Phase 0). Every assignment starts with "Read
   `.consort/pr-review/brief.md` and `.consort/pr-review/categories.md` first", then says
   only what is specific to that agent. An assignment is under ~1,500 characters. Never
   paste the PR body, flow list, repo rules, or the categories brief into a prompt.
3. **Every agent writes its own report to disk** at `.consort/pr-review/agents/<slug>.md`
   and returns the same text. On any resume, read `.consort/pr-review/agents/` first and
   dispatch only the groups that have no report. Never re-dispatch a group whose report
   exists.

## Keep the user informed at the phase boundaries

Before the first tool call, one or two sentences: what behavior this PR changes and what
you will check first. Then one short plain-language update at each transition — scope done
(file count, CI state, what looks risky), wave dispatched (how many agents, what they own),
wave back (what stood out, what is still open), verification done (confirmed counts), report
written. Say what it means for someone using the feature, not which command ran. Distinguish
a suspected issue from a confirmed one. Tool output is not an update; a running commentary
every few tool calls is not wanted either.

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
gh pr diff <n> --repo <owner>/<name> --stat
gh pr checks <n> --repo <owner>/<name>
```

**No PR body, no review.** If `gh` is missing, `git fetch origin
refs/pull/<n>/head:refs/remotes/origin/pr/<n>` gets the code but not the description —
stop and ask Mitch to paste it. The body says what is out of scope and what the follow-up
covers; without it you invent the author's intent and then find fault with the invention.

**Then check it earns a review.** Give a verdict in chat and stop if the diff is under ~50
lines with no new logic (a rename, a copy change, a dependency bump). A deliberate first
step is not an incomplete feature. Everything else gets the full procedure, scaled to the
results.

- Pin the **review SHA** (PR head) and base — every `file:line` refers to it.
- Later commits that invalidate this PR: `git log <base>..origin/<baseRefName> -- <key files>`.
- Read the repo's `CLAUDE.md` (and nested ones under the touched packages) if it has one;
  otherwise its README / CONTRIBUTING. Style findings are judged against those, not taste.
- Grep test coverage once, up front, using the repo's own test layout (aligned-mono:
  `tests/ packages/` with `*.test.ts|*.spec.ts`; a Python repo: `tests/` with `test_*.py`):
  `grep -rln --include='*.test.ts' --include='*.spec.ts' -E '<NewSymbol|OtherSymbol>' tests/ packages/`.
- Record CI for the pinned head SHA: passed, failed, pending, missing, with links. Do not
  report an older SHA's green checks as current. **Do not run tests for this review.**
  Passing CI is execution evidence, not coverage evidence; agents read the assertions.

**Write `.consort/pr-review/brief.md`** with, in order: repo `owner/name` and local root ·
PR number, title, URL · head and base SHA · the PR body verbatim · CI status with links ·
the entrypoints you enumerated in Phase 1 (untraced) · the relevant `CLAUDE.md` excerpts ·
the test-grep results · the group table from Phase 2 (`group slug | files | hunks | owner
of which entrypoints`). This is the only place any of that is written down.

## Phase 1 — Flows

The spine of the document. Enumerate every entrypoint the PR adds or touches, in the repo's
own terms, from the diff stat and the file list — that is cheap and needs your judgement.
aligned-mono: controllers (auto-mount at `/api/<namespace>/<filepath>`; name the auth),
crons (schedule from `infra/src/cron.ts`), workers (`<NAME>_JOB`, and who dispatches it),
frontend pages, webhooks in, vendor calls out. A Dagster repo: assets, jobs, schedules,
sensors, and the external systems they read/write.

**Tracing is reading, so the file agents do it.** Each entrypoint is assigned to the group
that owns its file (Phase 2); that agent returns a `FLOW` record with the hop list, the
gate, and the real-world effect. No separate tracer agents, no second "pin the lines" pass:
the hops come back with `file:line` the first time or the agent says where the trail went
cold. You assemble the map, resolve contradictions, and decide the ordering.

> **Flow N — <name>.** Trigger: who starts it, from where.
> Hops, each with `file.ts:line` — route → service → DB write / dispatch / external call.
> Ends in: the real-world effect. Reachable today: yes / no (name the gate).

Money and data-writing flows first, reads last. Mark which are human-driven and which run
unattended — unattended flows have no reviewer as a backstop. Name the gates. A page, max.

Every defect's "Example flow" must be an instance of one of these.

## Phase 2 — group the files, then fan out once

**Group for evidence, not for count.** The unit of work is a set of files one reader has to
hold together to judge any of them:

- A source file travels with its own test/spec, stories, and mock handlers. A test agent
  cannot judge coverage without the source open, and the source agent cannot judge the tests
  without the assertions open, so splitting them reads everything twice.
- Small related files in one subsystem (a schema + its index barrel + the api wrapper, or a
  set of thin controllers that all gained the same guard) share one agent.
- A large or central file — the service the PR is about, the auth module, the migration —
  gets its own agent, still with its tests. A very large file may be split by hunk range,
  with one agent named as owner.
- Docs, fixtures, constants, generated files, config, e2e manifests go to one catch-all
  agent that checks the generation contract or remaining callers and records limits.

Aim for roughly 2–5 files or up to ~400 changed lines per agent. A real PR lands between
4 and 12 agents; go past 12 only when the diff genuinely has that many independent
subsystems, never because the file count is high. Write the group table into `brief.md`.

Dispatch **every group in one message**, `run_in_background: false`, at the delegate tier.
`--fanout N` caps how many run at once; if the group count exceeds it, dispatch in waves,
each wave one message. Each assignment, in this order and nothing more:

> Read `.consort/pr-review/brief.md` and `.consort/pr-review/categories.md` first.
> You own group `<slug>`: `<files>` at head `<sha>`, hunks `<ranges>`. Trace entrypoints
> `<E3, E5>` and return a FLOW record for each. Start with `<the risk you already suspect
> for this group>`. Read every changed block, the enclosing functions, and any callee you
> need to judge a call; grep for peers and existing equivalents. Return DEFECT / ITEM /
> GOOD / OPEN / FLOW / COVERED records per the brief's Return format. Write the same text
> to `.consort/pr-review/agents/<slug>.md`.

Each agent covers **all** concerns for its files — security, logic, redundancy,
performance and reliability, style and comments, tests — because those judgements need the
file open. The group boundary limits the assignment, not the evidence: agents follow
callers and callees wherever they lead.

## Phase 3 — verify, then cut

Read the returned reports. Re-open every cited `file:line` yourself at the review SHA and
trace the guard or caller the claim depends on before deciding. For each candidate record
one of: **confirmed defect** (reachable trigger and consequence) · **confirmed item** (the
category's required evidence) · **duplicate** of a retained candidate · **disproved**
(name the guard, caller, assertion, or counterexample) · **open** (what evidence is missing).
Keep the dispositions in `brief.md` under a `## Ledger` heading, one line each.

**One bounded follow-up wave, at most.** Send back only OPEN candidates that would be
🟥/🟧 if true or that change the headline, each as a single-question assignment naming the
exact evidence needed. Everything else that stays open goes in the Appendix as a question.
No pre-emptive specialists: an infra or frontend specialist runs only when a group report
raises a cross-cutting concern it could not settle. Do not discard pagination or
query-per-item concerns without checking bounds and callers.

A defect must be introduced or worsened by this diff and have a nameable trigger. A category
item need not have a failure scenario: style, redundancy, comments, and test gaps remain
first-class findings. Respect the PR's stated scope, but a follow-up note does not excuse a
current reachable defect. Deduplicate the same root cause, not distinct issues in one file.
No quota in either direction: do not stop after the first defect, do not pad.

### Not a finding

These verify clean and are still worthless — cutting them is the most valuable thing this
phase does. `categories.md` → False-positive traps is the full list; the ones that survive
most often:

- Work the PR body calls a follow-up, unless it is a reachable defect in code that ships.
- Missing docs, unless the PR makes an existing doc wrong.
- Ops work that isn't code; merge-process advice; "X is now a hard dependency."
- Guards for states that cannot occur.
- "No test exists" without the grep coming back empty for the symbol *and* its class.
- Consequence-only severity. If you cannot name who triggers it and why, there is no defect.

Before writing, confirm every group has a report. A missing report means partial coverage:
dispatch that group (once) or disclose it. Zero findings is a normal answer after a
completed investigation, never a substitute for one.

## Phase 4 — severity and category

Severity is consequence, for DEFECTS only, and never promotes a non-defect. Use the
definitions in `categories.md` → Severities, restated in the PR's own domain terms in the
"How to read this" legend. ITEMS are unranked; they sit in their category section in
`file` order.

## Phase 5 — the review file

Write the file after verification, including when no confirmed findings remain — the Flows
map is worth it on its own. Save it to `.consort/pr-review/pr-<n>.review.json` in the
worktree (`--repo` reviews too: the file lives in the worktree the chat runs in). Every string
is plain prose per **Voice**; no HTML, no Markdown headings inside fields. Every `file` is
repo-relative and every `line` is verified at the review SHA — GitHub attaches the comment to
that exact line.

```jsonc
{
  "version": 1,
  "repo": "owner/name",                       // the PR's repo, for posting
  "pr": 402, "url": "https://github.com/owner/name/pull/402",
  "title": "Member match trigram model",      // two to four plain words; prefix the repo when it isn't aligned-mono
  "subtitle": "one line on what the PR is for",
  "head": "<full head sha>", "base": "<full merge-base sha>", "state": "OPEN",
  "stats": { "files": 17, "additions": 812, "deletions": 140 },
  "reviewedAt": "2026-09-21T15:04:00Z",
  "ci": { "status": "all required checks pass at 489353a", "url": "<checks url>" },
  "method": "20-agent fan-out, every cited line re-verified by hand",
  "whatItDoes": "plain prose, no code words",
  "shipsToday": "gates and flags",
  "headline": "one-paragraph verdict, including what is good",
  "pattern": "optional — only when several defects share one shape",
  "flows": [
    { "name": "Reviewer maps a practice", "trigger": "who starts it, from where",
      "hops": [ { "text": "route", "ref": "file.ts:12" }, { "text": "service", "ref": "file.ts:80" } ],
      "endsIn": "the real-world effect", "reachable": true, "gate": "FLAG when reachable is false",
      "mode": "human" }                       // or "unattended"
  ],
  "findings": [
    { "id": "D1", "kind": "defect", "severity": "high", "category": "logic",   // category = origin, optional
      "title": "heading that states the consequence",
      "file": "packages/core/src/services/x.service.ts", "line": 565,
      "problem": "1–2 plain sentences, then the ref", "exampleFlow": "real values, one breath",
      "fix": "the smallest one", "ignoreIf": "the assumption under which it's fine",
      "comment": "x.service.ts:565 — one sentence in Mitch's voice, ready to post",
      "status": "pending" },
    { "id": "T1", "kind": "item", "category": "tests",
      "title": "what has no test or is wrong", "file": "tests/standard/x.test.ts", "line": 3,
      "fields": { "Costs": "…", "Suite": "standard — tests/standard/x.test.ts", "Test": "the one assertion" },
      "comment": "tests/standard/x.test.ts:3 — ready-to-post comment",
      "status": "pending" },
    { "id": "L1", "kind": "item", "category": "logic",
      "title": "a PR-level concern with no honest line to pin",
      "fields": { "Gap": "…", "Fix": "…" },
      "comment": "Ready-to-post general PR comment with no invented file or line",
      "status": "pending" }
  ],
  "testsExisting": "one sentence on the PR's test files and what they prove",
  "appendix": [ "coverage evidence and open questions, one string each" ],
  "wellBuilt": [ { "what": "…", "why": "…", "ref": "file.ts:12" } ],
  "orderOfWork": [ { "step": "do this", "why": "why first", "refs": ["D1", "T1"] } ]
}
```

Rules for the file:

- **ids** are stable and unique: `D1…` for defects in severity order (crit → high → med →
  low), `L1…` `R1…` `S1…` `T1…` `C1…` for Logic, Redundant, Style, Tests, Comments items.
- **severity** only on defects; **category** on every item, and on a defect only as its origin.
- **fields** carry exactly what the category's card shows, in this order — Logic: `Gap`,
  `Fix` · Redundant: `Overlap`, `Do` (name the existing definition's `file:line` in Overlap) ·
  Style: `House way` (with the peer `file:line`), `Fix` · Tests: `Costs`, `Suite`, `Test` ·
  Comments: `Trimmed` (the replacement comment, newlines allowed).
- **comment** on every retained finding: ONE sentence, plain, direct, ready to post. For a
  code-specific finding, open with the exact `file:line`. Model:
  `sigma-md.service.ts:214 — Nothing tests retry429MaxWaitMs — add a test that a retry-after:
  600 with a small cap resolves fast, so a unit slip here doesn't hang the mapping save.` Do
  not leave a blank field for Mitch to write.
- **file** and **line** are required when a finding belongs to a changed line, and they must be
  verified at the review SHA. When there is genuinely no applicable code location, omit both and
  write the comment as a general PR comment; Consort will put it in the review body instead of
  inventing a location.
- **status** is always `"pending"` when you write the file. Mitch sets the rest; if you are
  re-running a review whose file already exists, read it first and carry forward every
  finding's `status`, `comment` edits, `posted`, `head` and `investigation` records where the
  finding is the same. Consort fills `head` and `investigation` itself when Mitch re-checks a
  finding against newer commits; never write them fresh.
- Order flows money/data-writing first, reads last; defects by severity; items in `file` order.
- Appendix always carries coverage: reviewed head/base, file and block coverage, agent counts
  and waves, per-agent results and incomplete tasks, CI SHA/status/link, "no tests run locally".
- Nothing else: no extra top-level keys, no HTML, no emoji.

## Phase 6 — summary and link

After saving the review file, print a short operational summary in chat, even with no findings:
- PR, head and base SHA; files covered out of changed files.
- Agent count (groups, plus any follow-up or escalated agents) and any group that had to be
  re-dispatched, with why.
- Confirmed defects by severity; category items; disproved and open counts.
- CI status for the reviewed SHA, and "No tests run locally."

Put the same in the file's `appendix`. End the response with the clickable link on its own
line: `[PR <n> review](<absolute-worktree-path>/.consort/pr-review/pr-<n>.review.json)`. Use
the real saved path; if the file could not be written, say so instead of printing a broken
link. Then stop — approving, ignoring and posting the comments is Mitch's step in Consort.

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
- The schema is law. A key the viewer does not know is never shown. Omit `file` and `line` only
  for a genuine general PR comment; otherwise a verified `file:line` is required.
- Last pass: read the list as the author. Anything that earns "no shit" / "that's a
  follow-up" / "that's just how it works" should have died in Phase 3. Kill it now.
- Same pass, for voice: any claim you can't follow without opening the file isn't finished.
  Agents return findings in code vocabulary — that's their format, not the document's.
  Rewrite every one of them per **Voice** before it ships.
