# /ship in Consort — agreed design (2026-09-29)

Status: decisions settled, waiting on Peter's `ship.py` and skill text as reference. Nothing built yet.

## What /ship is

A pipeline that takes one feature from a ticket to a merged PR: grill the idea into a spec, implement,
test, review, merge. Peter's version is a Claude Code skill in `~/command-center` driven by ClickUp
(branch `origin/feat/seat-pool-and-ship`). Ours lives in Consort's source, the way the PR reviewer does
(`src/shared/reviewRunner.ts`), with per-feature state in Consort's store.

## Decisions

1. **In Consort, not an external skill.** Pipeline prompt and stage logic in `src/shared/`, runner in
   `src/main/`. `ship.py` is reference for the stage rules, not something we call.
2. **Ticket sources: GitHub issues and ClickUp tasks.** Both from day one. A feature carries
   `{ source: "github" | "clickup", id, url, title }`.
   - GitHub: stage as labels `ship:<stage>`; close the issue on Merged.
   - ClickUp: stage as the task status, as Peter's skill does. API key in Settings (same pattern as the
     OpenRouter key) for Consort's own reads; the chat keeps whatever ClickUp access the connector has.
3. **A feature is a worktree.** Shipping creates a feature branch worktree exactly like the project
   page's new-worktree flow, in the same location. The /ship chats run inside it. Multi-repo features
   use a workspace later, not in the first cut.
4. **Branch names.** `<prefix>/<slug>-<ticket id>`, slug from the ticket title, a few words. The prefix
   is one global setting in Settings (Mitch: `mm`) applied to every branch Consort generates, including
   Branch and solve. Base branch is the project's, e.g. `development` on aligned-mono.
5. **Stages.** Grilling → Spec'd → Implementing → Ready to Test → Revising → In Review → Merged (Closed
   for abandoned). Ready to Test means the repo's test suite plus a run of the existing PR reviewer, then
   Mitch approves. The grilled spec is posted as a comment on the ticket.
6. **Where it shows.** A stage progress bar above the chats of a ship worktree, with the next step as a
   button. A larger "ship info" block top right if it needs more room. A Ship button next to each open
   issue on the project page, and a way to ship a ClickUp task by id or link.
7. **Chats.** Each stage runs as its own chat in the worktree (build and test stay separate sessions).
   Auto-approve on by default for ship chats. Every reply ends with the
   `Stage: … · Ticket: … · Next: /ship …` footer, rendered as chips that clear then resend.

## Open until ship.py arrives

- How the skill grills: the question rounds and when it decides the spec is done.
- How it checks out repos and opens PRs, to see what to keep versus replace with Consort's worktree code.
- The exact test report shape, if we keep the pass/fail story summary.

## UI (agreed 2026-09-29)

- **Project page, Open issues:** a Ship button on each issue row, beside Branch and solve. Creates the
  feature worktree and starts the grilling chat.
- **Project page, Ship ClickUp:** shown only when a ClickUp API key is set in Settings. A box for a
  task id or link; ships that task into a new worktree with a generated branch name.
- **Settings:** ClickUp API key; global branch prefix (applies to every generated branch name).
- **`/ship` command in any chat:** `/ship new <idea>`, `/ship <ticket>`, `/ship <ticket> approve`,
  `/ship <ticket> pr-loop`, `/ship <ticket> "<feedback>"`, `/ship pause <ticket>`. Typed in a ship
  worktree it runs there; `/ship new` from elsewhere creates the worktree first.
- **Ship worktree, full-width progress bar** above the chats: the stages with the current one lit,
  the ticket, and the next step as a button.
- **Ship worktree, top-bar button** opening a panel with everything about the feature: ticket link,
  spec, PRs, test report, review findings, generated documents, stage history.
- **Next chips** under each ship reply, from the `Next:` footer, that clear the chat and resend.
