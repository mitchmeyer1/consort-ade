# Flows

Every way a developer moves through Consort, what they see at each step, and how they know whether the next move is theirs. Each flow names the entry point, the states it passes through, and where it ends. "You act" marks the steps that wait on the person.

Shared conventions these flows rely on:

- **Where am I.** The sidebar is projects → worktrees → chats. The top bar names the worktree and branch. A chat shows the phase strip (waiting · planning · executing · validating · complete) across the top and, for a ship chat, the SHIP card at the right.
- **What is happening.** Running work shows a spinner on its sidebar row, a "Working…" footer in the chat, and the live PLAN card at the left of the chat. Terminals show a dot per running process.
- **Is it my turn.** A chat that needs you sits at the *waiting* phase with a question or a permission prompt. Cards and bars put the one thing you can do next as a single primary button; secondary choices are plain text beside it.
- **Where did it go.** Anything Consort writes into your repository goes under `.consort/` in that worktree, which Consort keeps out of git via `info/exclude`. Chat artifacts, review files, ship documents, notes and ticket dossiers all live there and open from the Artifacts tab.

## Getting set up

| Step | You see | You act |
|---|---|---|
| First launch | The empty state: Consort's mark, two buttons. | **Connect agents** (Settings › AI connectors) and **Add projects**. |
| Connect an agent | Settings › AI connectors lists the Claude Code and Codex CLI logins and any API keys. Each shows signed-in state and plan usage. | Press **Sign in** on a login (a terminal tab runs the CLI's login), or **＋** to add an API key or a second login. |
| CLI runtimes | Under the connectors: the Claude Code and Codex binary in use, bundled or downloaded, and whether the registry has a newer one. | Nothing. Consort fetches a newer CLI at launch, daily, and when a model demands it. **Check for CLI updates** forces it. |
| Add a project | A folder picker. A git repository becomes a project with a Root checkout; a plain folder becomes a home with one chat scope. | Pick the folder. |

## Working in a project

**Project page.** The title block, then the *New worktree* chapter with four cards (New worktree, Ship, PR review, Investigate), then Quick actions, the Root checkout and Commit-and-push cards, the worktree grid, your PRs, other PRs, open issues and recent CI.

| Flow | Entry | Steps | Ends |
|---|---|---|---|
| New worktree | Project page › New worktree card, or **＋** on the project row | Name the branch; Consort cuts it from the base branch into its own folder. | A worktree in the sidebar with its page open. |
| New chat | **＋** on a worktree row, or **New chat** on a worktree page | Pick connector and model; type the first message. | The chat opens at *waiting*, then runs. |
| Switch Root | Project page › Root card | Pick a branch; Consort checks it out at the repository's own path. | The Root row shows the new branch. |
| Push and check out at root | Worktree card › **Push and checkout at root** | Confirm a commit message if the worktree is dirty. | Root is on the worktree's branch; the worktree is left detached. |
| Commit and push | Project page › Commit and push, or **commit** in a chat's footer | Type a message or let the agent write one. | The branch is pushed; the card shows "0 unpushed". |
| Create PR | Worktree page › **Create PR** | Title and body (or **Generate** from the commits). | The PR badge appears on the worktree. |
| Quick actions | Project page › Quick actions, or a pinned action in the top bar | Run a saved command in a terminal tab; **Gen All** proposes actions from the repo. | Output in the Terminal drawer with a dot until read. |

## Chatting with an agent

| Step | You see | You act |
|---|---|---|
| Send | The message bubble; the phase strip moves to *planning* then *executing*; the PLAN card lists the agent's steps and ticks them. | Type more to queue it; **Stop** to interrupt. |
| Permission | A card in the chat naming the tool and input. | **Allow** or **Deny**; or turn on **Auto-approve**. |
| Waiting on you | The strip rests at *waiting*; the chat's sidebar row shows an attention dot and a notification fires if Consort is not focused. | Reply. |
| Done | *complete*; artifacts the agent produced appear as chips under the reply and in the Artifacts tab; follow-up chips suggest next prompts. | Open an artifact, click a follow-up, or move on. |
| Side chat | **SIDECHAT** in the footer. | Ask a read-only second agent about the running job. |
| Terminal and Editor | Top bar tabs. | Run commands in the worktree; edit any file (⌘S saves). |
| Notes | Top bar › **Notes** | Add bullet notes kept in the worktree; pin one to show it beside the branch in the sidebar. |
| Scratchpad | Sidebar foot › **Scratchpad** | Free-text tabs that persist across restarts, not tied to any project. |

## Shipping a ticket (`/ship`)

Entry: the **Ship** card on the project page (GitHub issue or ClickUp task), **Ship** beside an open issue, or `/ship new <idea>` in a chat.

The SHIP card at the right of the chat lists every stage, ticks the finished ones, explains the current one, and holds the next step as a button. Hover a finished stage for **Redo**. The TICKET card at the left shows the ticket's status and sub-tasks as the tracker reports them.

| Stage | What happens | You act |
|---|---|---|
| Grilling | The agent interviews you in rounds, checks whether the change breaks an existing flow and asks before proceeding if so, then writes `SPEC.md` and posts it to the ticket. | Answer the numbered questions; say "stop" or **Continue grilling**. |
| Spec'd | The spec is on the ticket. | **Start building**. |
| Implementing | The spec becomes tickets under `.consort/ship/issues/`; each is built, committed and pushed; a draft PR opens; then every story is verified and `TEST-REPORT.md` written. | Confirm the breakdown once; otherwise watch. |
| Ready to Test | The report maps stories to proof. | **Approve**, or **Give feedback…**. |
| Revising | Feedback is applied and stories re-verified. | Watch; approve again. |
| In Review | The PR is marked ready. Consort runs its own PR review as the next turn of the same chat, then **Work the review** adjudicates findings, fixes the real ones and answers threads, up to three rounds. The review itself is the interactive Review drawer. | Rule on findings in the Review drawer; merge on GitHub when satisfied. |
| Merged / Closed | The ticket is closed with a note. | Nothing. |

**Pause** at any stage writes `HANDOFF.md`; **Resume** reads it back.

## Reviewing a PR

Entry: the **PR review** card, **Review** beside a PR, or **PR write-up** on a worktree page.

| Step | You see | You act |
|---|---|---|
| Pick | A dialog for connector and model (agents run one tier below). | **Review**. |
| Run | A worktree on the PR branch; the REVIEW card shows scope → flows → agents → verify → publish. | Watch. |
| Ready | A "Review ready" card and the **Review** tab. | Open the drawer. |
| Decide | Each finding with its evidence: **Comment on PR**, **Ignore**, **Fix locally**, **Re-investigate**; a drift banner when the PR moved. | Decide finding by finding; **Submit** posts only what you approved. |

## Investigating a ticket

Entry: the **Investigate** card (GitHub issue or ClickUp task).

Consort fetches the ticket, its comments and one hop of linked tasks, issues and PRs into `.consort/investigations/<id>/DOSSIER.md` in the Root checkout and opens a chat there. The brief has four fixed headings: Situation, Progress so far, Remaining to-dos, Unanswered questions. Links Consort cannot read are listed for you to paste in. Nothing is written to the tracker and no branch is cut.

## Unattended, on a server (consort-cli)

The same /ship pipeline with no window. A daemon scans a ClickUp list or a repo's issues on a timer, claims what matches, ships each ticket in its own worktree, asks you on Slack only what matters, runs three review rounds on rotating models, answers human reviewers on the PR, and pings you when it is ready to merge. Setup and the full flow are in [CLI.md](CLI.md).

## Multi-repo workspaces

Entry: **＋** on Projects › Multi-repo workspace.

One chat scope over several checkouts, with a Commit… button that commits every dirty repo with one message and a Create PRs button for every repo with unpushed commits.

## Known rough edges

- Screenshots in this document and the README are rendered from the app's CSS, not captured from a running build.
- Autopilot (desktop control) needs an OpenRouter key and macOS accessibility permission; it is off until both exist.
- ClickUp features (Ship from a task, ticket status, Investigate) need the API key in Settings › Ship.
