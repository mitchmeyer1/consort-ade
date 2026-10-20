# consort-cli

Consort's ship pipeline with no window: a daemon on a Linux or macOS box that watches a ClickUp list or a repo's issues, claims the tickets that match, and ships each one in its own worktree. Questions reach you on Slack; everything else it decides and records. It never merges.

## Install

```bash
git clone https://github.com/mitchmeyer1/consort-ade.git && cd consort-ade
pnpm install --ignore-scripts      # skips the Electron and node-pty builds the desktop app needs
pnpm build:cli
npm link                           # or: alias consort-cli="node $PWD/out/cli/index.js"
```

Needs Node 22.12+, git, and the GitHub CLI (`gh auth login`) for PRs and issues. The Claude Code and Codex binaries come with the install as platform packages; `consort-cli cli update` fetches newer ones.

State lives in `~/.consort-cli/state.json` (mode 600; it holds API keys), logins in `~/.consort-cli/logins/<account>/`, worktrees in `~/.consort-cli/worktrees/`, logs in `~/.consort-cli/logs/`. Set `CONSORT_CLI_HOME` to move it.

## Set up, once

```bash
# 1. the repo, checked out on its base branch
git clone git@github.com:you/roster-service.git ~/repos/roster-service

# 2. AI accounts: CLI logins run the provider's login in your terminal; API keys are stored
consort-cli accounts add --provider claude --name work
consort-cli accounts add --provider codex --name work
consort-cli accounts add --provider claude --name billing --api-key sk-ant-…
consort-cli accounts list

# 3. Slack: a bot token with chat:write, im:write and im:history, and your user id
consort-cli slack set --bot-token xoxb-… --user U0123ABC
consort-cli slack test                      # posts a hello into your DM

# 4. trackers
consort-cli clickup set-key pk_…
consort-cli prefix set bot                  # branches become bot/<slug>-<ticket id>

# 5. a job: what to scan, how often, which tickets qualify
consort-cli jobs add --name roster --source clickup --list 901234 \
  --repo ~/repos/roster-service --base main \
  --tag ai-handle --status "to do" --every 15
consort-cli jobs scan <job id>              # dry run: which tickets would be taken
```

GitHub issues work the same with `--source github` and no `--list`; filters apply to labels and the issue title. Every filter must hold: `--tag` (any of), `--status` (any of), `--name-includes` (all), `--name-excludes`, `--assignee`.

## Run

```bash
consort-cli run
```

Keep it running under `systemd`, `tmux` or `nohup`. Every `--every` minutes it scans each job, skips tickets another consort-cli has claimed (a `[consort-claim host=… at=…]` comment on the ticket, honoured for three days), claims up to `--max-parallel` new ones, and starts a worker process per ticket. Workers that die are restarted at the next pass; `consort-cli status` shows them, `consort-cli tasks logs <task>` shows a worker's log.

## What a worker does

1. Cuts `bot/<slug>-<id>` from `origin/<base>` into `~/.consort-cli/worktrees/<slug>-<id>`, writes `.consort/ship/TICKET.md`, opens a Slack thread for the ticket and moves its status to *in progress*.
2. **Grilling, headless.** The agent reads the ticket and the code, decides everything straightforward itself and lists those as Assumptions in the spec. Only material open questions reach you: a Slack message in the thread, numbered, each with a recommended answer. Reply in the thread; one message is enough. The worker waits as long as it takes.
3. **Implementing.** Tickets from the spec, built, committed, pushed; a draft PR. Then the test session proves every story and writes the report. The worker approves on your behalf and marks the PR ready.
4. **Three review rounds.** Consort's own PR review, each round on a different model: Codex's strongest, then Claude's strongest, then the next Claude family down (configurable with `--review-models`). After each round the builder fixes what is real and pushes.
5. **Reviewers.** The people who touched the changed files most are requested on the PR.
6. **The watch.** Every 15 minutes the worker reads the PR. New review threads from humans are answered: clear requests are fixed, pushed, replied to and resolved; anything unclear or disputed gets one neutral reply and a Slack question to you. CI and approvals are read each pass.
7. **Ready.** One human approval, no changes requested, no open threads, CI green: you get a Slack message with the PR link and the ticket gets a final comment. Merging is yours.

Every stage move is posted to the Slack thread and as a comment on the ticket; the ticket status moves to *in review* when the PR is up and to *complete* if the PR is merged while the worker is still watching.

## Slack messages you will see

- `Picked up <title>. Working on branch …` — the thread opens.
- `→ Spec'd — Spec written headless in 1 round.` — a stage moved.
- `I need you on 2 things …` — answer in the thread.
- `Review round 2 on claude-fable-5-1: 4 findings, fixing the real ones.`
- `Asked @ada, @grace to review.`
- `Ready to merge. Approved, no open threads, CI green: <PR>` — done.
- `I am stuck: …` — three turns without progress; reply with instructions or run `consort-cli tasks release <task>`.

## Commands

| Command | Does |
|---|---|
| `accounts add --provider claude\|codex --name <label> [--api-key k]` | add an account; without a key runs the CLI login |
| `accounts list` / `accounts remove <id>` | |
| `slack set --bot-token … --user … [--channel …]` / `slack test` | |
| `clickup set-key <key>` / `prefix set <prefix>` | |
| `jobs add …` / `jobs list` / `jobs scan <id>` / `jobs enable\|disable <id>` / `jobs remove <id>` | |
| `run` | the daemon |
| `tasks list` / `tasks logs <id>` / `tasks release <id>` | release stops the worker and forgets the claim locally |
| `cli status` / `cli update` | the Claude Code and Codex binaries |
| `status` | one line per live task |

## Accounts and usage limits

Add as many accounts per provider as you have (`accounts add` once per login or key). A task sticks to one account per provider; when that account hits a usage limit the worker blocks it until the provider's reset time (or an hour when it does not say), says so in the Slack thread, and continues on the least recently used account of the same provider, starting a fresh session (the stage handlers pick up from the files on disk). With every account of a provider out, the worker waits for the first to free up. `accounts list` shows blocks; `accounts unblock <id>` clears one by hand.

Nothing asks for permission: Claude Code runs with permissions bypassed and Codex with approvals off and full access on the box, so run consort-cli on a machine you dedicate to it. Both agents may search and read the web for research.

## Watching it

```bash
consort-cli view
```

A live table: ticket, title, stage, status, the account in use, how long it has run, and what the worker is doing right now. Finished tasks stay for two hours, then drop off. Below it, the accounts (and any blocks) and the jobs with their next scan. `q` quits.

## Limits of this cut

- Model lists are the seed lists; pass `--review-models` to name others.
- Slack is polled, not pushed, so an answer is seen within about 20 seconds.
- A ticket released with `tasks release` keeps its claim comment on the tracker; delete it there if another box should take it.
