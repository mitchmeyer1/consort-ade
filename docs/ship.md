# /ship — how it works in Consort

A feature goes from a ticket to a merged PR through fixed stages:
Grilling → Spec'd → Implementing → Ready to Test → Revising → In Review → Merged → Closed.

The stage machine comes from an earlier Claude Code skill. Consort keeps the state instead of a
`state.json` and a CLI, the ticket is a GitHub issue or a ClickUp task, and the code
lives in a worktree Consort made.

## Starting a feature

- **Project page › Open issues › Ship**: the issue is the ticket.
- **Project page › Ship a ClickUp task** (shown once a ClickUp API key is saved in Settings › Ship):
  paste a task id or link.
- **`/ship new <idea>`** typed in any chat of a project worktree: Consort opens a GitHub issue from
  the idea and ships that.

Consort resolves the ticket, cuts a branch `<prefix>/<slug>-<id>` from the project's base (the prefix is
Settings › Ship › Branch prefix, applied to every generated branch including `issue/<n>`), creates the
worktree where the project's worktrees go, records the feature on it, and opens the first chat.

## Running stages

Each stage is one chat in the feature's worktree, auto-approved by default (Settings › Ship). The prompt
is built in `src/shared/shipPrompt.ts` from the feature's state and the command:

| Command | Does |
|---|---|
| `/ship` | the next step for the stage the feature is in |
| `/ship approve` | tests are blessed: the draft PR is marked ready and Consort's self-review starts (In Review) |
| `/ship pr-loop` | work through one round of the self-review's findings, fix, push, ask for the next round |
| `/ship "<feedback>"` | enter Revising with that feedback |
| `/ship pause` | write a handoff a fresh session resumes from |

The buttons on the stage bar and in the Ship drawer send these; Next chips under a reply clear the
context then send the reply's own `Next:` command.

Every message in a ship chat, typed or from a button, carries a short `/ship status` header
(`src/main/agents.ts` › `runSend`): the stage line with the current stage marked, the step this turn is
on, how many turns the chat has taken at that stage, and the markers. The full handler text rides only
when the stage moved, the chat was continued after an interruption, or the session is fresh. In
Implementing, the ticket breakdown is written to `issues/` as `Status: proposed` and moves the stage at
once, so a repeat of the step confirms the breakdown instead of re-deriving it.

## The review step is Consort's own PR review

In Review does not use an external bot. When a feature enters In Review with a PR (or the agent emits
`[ship-review-round: N]` after pushing fixes), main starts the **pr-writeup** review in a new chat of the
worktree named `Review PR #<n> · ship round N` on the ship connector's orchestrator/delegate tiers
(`startShipReview` in `src/main/index.ts`). It writes `.consort/pr-review/pr-<n>.review.json`, which the
review drawer renders with Comment on PR / Ignore / Fix locally per finding; in a ship worktree "Fix
locally" goes to the ship chat. When the review chat finishes, main runs `/ship pr-loop` in the
worktree's idle ship chat: the agent adjudicates every finding the user has not ignored, waits for the
go, fixes, pushes, and asks for the next round. Three rounds at most (`SHIP_REVIEW_ROUNDS`). The feature
records the latest review on `ship.review` and the Ship drawer links it under Documents.

## How state moves

The agent reports with markers Consort strips from the reply: `[ship-stage: <stage> | note]`,
`[ship-built]`, `[ship-pr: url]`, `[ship-next: /ship …]`, `[ship-spec: path]`, `[ship-report: path | pass/total]`,
`[ship-pause]`, `[ship-resume]`, `[ship-feedback: user|bot|teammate]`, `[ship-review-round: N]`
(`src/shared/ship.ts`). A stage move is written to the ticket by `src/main/ship.ts`: a GitHub issue gets
the one `ship:<stage>` label (created on first use), a comment with the note and the spec on Spec'd, and
is closed on Merged; a ClickUp task gets its status set to the list's own status whose name matches the
stage (any case or punctuation; a list without one gets the comment alone) and the same comment.
A write that fails is recorded on the feature's `sync` and retried by main on a backoff (30s doubling to
10 minutes) until it lands, plus at start-up and the moment a ClickUp key is saved. The stage bar shows
nothing about it; the Ship drawer's last line says when the ticket was updated or that a retry is pending.

Artifacts live in the worktree under `.consort/ship/` (SPEC.md, GRILLING.md, issues/, TEST-REPORT.md,
HANDOFF.md, review/), excluded from git through the repo's `info/exclude`.

## What the UI shows

- A stage bar above a ship worktree's chats and above each chat in it, with the ticket, PRs, story
  count and the next step as a button.
- A **Ship** button in the top bar of a ship worktree that opens a drawer with the ticket, next step,
  documents, PRs, history, ticket-sync status and the feature's chats.
- On the project page, an issue being shipped shows its stage instead of the Ship button.

## Not in this cut

- `/ship new` on a ClickUp list (ship an existing task by id instead).
- Multi-repo features (workspaces).
- Separate story-test scripts; the test session runs the repo's own suite and verifies stories by
  hand, writing TEST-REPORT.md.
