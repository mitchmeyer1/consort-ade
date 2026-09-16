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

**Brief beats thorough-sounding.** Budget per item: ≤60 words a finding, ≤50 a flow,
one short paragraph for the headline. One sentence that lands beats a paragraph that
explains. Twenty real findings earn a long document; two earn a short one. Banned at any
size: filler, hedging, restating the diff, or a second sentence saying what the first
already said.

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

**Then check it earns a document.** Give a verdict in chat and stop if the diff is under
~50 lines with no new logic, or if its stated purpose is to try something somewhere
low-stakes. A deliberate first step is not an incomplete feature.

- Pin the **review SHA** (PR head) and base — every `file:line` refers to it. Say so.
- Later commits that invalidate this PR: `git log <base>..origin/<baseRefName> -- <key files>`
  (`development` in aligned-mono, `main` in most other repos — use the PR's `baseRefName`).
- Read the repo's `CLAUDE.md` (and nested ones under the touched packages) if it has one;
  otherwise its README / CONTRIBUTING. Style findings are judged against those, not generic taste.
- Grep coverage once, up front, so agents inherit the evidence instead of guessing, using
  the repo's own test layout (aligned-mono: `tests/ packages/` with `*.test.ts|*.spec.ts`;
  a Python repo: `tests/` with `test_*.py`):
  `grep -rln --include='*.test.ts' --include='*.spec.ts' -E '<NewSymbol|OtherSymbol>' tests/ packages/`.

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

## Phase 2 — fan out

Batch the changed files (~4–6, same subsystem), one Agent each, **all in one message**.
Plus specialists where the PR touches the area: **infra** (timeouts, memory, bundle size,
native deps) and **frontend** (races, stale state, busy handling, a11y). `--fanout N` caps
the total. Tests, style, comments, redundancy and logic are **not** specialists — every
file agent covers all five categories for its own files, because those judgements need the
file open, not a birds-eye view.

Give each agent, in this order: repo (`owner/name`) + local root + PR number and review
SHA · its files · the Flows map · the PR body · the relevant `CLAUDE.md` text · the test-coverage grep from Phase 0 · the **whole
of `categories.md`**. Then the ask:

> Read every one of your files at the review SHA in full, plus any callee you need to
> judge a call. Report per `categories.md` → Return format. A DEFECT needs a failure
> scenario with inputs; an ITEM needs the fields its category's Shape names; a GOOD line
> per file where earned. Lines you did not read do not exist.

No speculation, no "consider extracting", no style nits dressed as bugs.

## Phase 3 — verify, then cut

Re-open every cited `file:line` yourself at the review SHA. Drop what does not survive,
downgrade what is milder than claimed, merge duplicates across agents. Anything resting on
state you cannot see (a live column, a key policy) is an appendix question, not a claim.

Then sort: a DEFECT is **a defect in this diff the author can fix in this diff** and has a
nameable trigger. An ITEM is a category finding with no failure scenario. An agent's DEFECT
with no real trigger drops to an ITEM in its origin category or dies; an ITEM that turns out
to have a trigger promotes to a DEFECT and keeps a category origin chip.

### Not a finding

These verify clean and are still worthless — cutting them is the most valuable thing this
phase does. `categories.md` → False-positive traps is the full list; the ones that survive
most often:

- Work the PR body calls a follow-up. The author already flagged it.
- Missing docs, unless the PR makes an existing doc wrong.
- Ops work that isn't code — add an alarm, a runbook, a checklist item.
- Merge-process advice: squash vs merge, commit hygiene, branch naming.
- "X is now a hard dependency." So is `DATABASE_URL`. Not a defect.
- Guards for states that cannot occur. Two stages, both handled → a third stage is fiction.
- "No test exists" without the Phase 0 grep coming back empty for the symbol *and* its class.
- Consequence-only severity. If you cannot name who triggers it and why, there is no defect.

Re-count. **Zero across every bucket is a normal answer** — say so in chat and write
nothing. A document with slots for findings will grow findings to fill them; the template's
"None found." line exists so an empty bucket costs one line, not an invented item.

## Phase 4 — severity and category

Severity is consequence, for DEFECTS only, and never promotes a non-defect. Use the
definitions in `categories.md` → Severities, restated in the PR's own domain terms in the
"How to read this" legend. ITEMS are unranked; they sit in their category section in
`file` order.

## Phase 5 — the document

Only if anything survived. **Do not load `artifact-design`** — the design pass is done and
frozen in `template.html`; loading it is where the drift came from.

1. `cp template.html` to the scratchpad and fill every `{{slot}}`. Repeat the blocks marked
   *repeat*; drop only the blocks marked *optional*. Every `<h2>` stays, in template order,
   even when its body is the `None found.` line.
2. **Never edit the `<style>` block, the font link, or the class names.** No new classes,
   no inline styles, no extra sections. If the content does not fit a slot, the content is
   wrong, not the template.
3. Title is `PR <n> · <Short name>` — two to four plain words; prefix the repo name when it
   isn't aligned-mono (`dagster-snowflake PR 193 · Enrollment pingback`). Favicon is always `📋`.
4. Publish with `Artifact`. Redeploying the same PR reuses the same scratchpad path.

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

Then give Mitch the link in one line.

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
  If it is 0, ship 0 and write no document.
- Frozen-behind-a-flag write paths are reviewed as live code.
- The template is law. A writeup that looks different from the last one is a bug.
- Last pass: read the list as the author. Anything that earns "no shit" / "that's a
  follow-up" / "that's just how it works" should have died in Phase 3. Kill it now.
- Same pass, for voice: any claim you can't follow without opening the file isn't finished.
  Agents return findings in code vocabulary — that's their format, not the document's.
  Rewrite every one of them per **Voice** before it ships.
