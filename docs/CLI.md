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
consort-cli setup
```

The walk-through does everything below in order and tests each piece as it goes: the tools on the box (git, a signed-in `gh`, the Claude Code and Codex binaries), the issue sources (a ClickUp key checked against the API, the list looked up so you pick statuses from its own names, or a GitHub repo checked with `gh`), the repository path and base branch (verified on origin), the AI accounts (each CLI login into this tool's own directory, separate from Consort desktop; API keys checked against the provider), Slack (a DM is sent and you confirm it arrived), and the permissions it needs (worktree directory writable, `git push --dry-run` to origin, the ClickUp list readable). Every step saves, so you can stop and rerun. On a rerun each step shows what is saved (scanners, the ClickUp token, branch prefix, accounts, Slack; secrets masked) and `y` or Enter keeps it, `n` replaces it or, for a scanner or account, removes it. Until it finishes, every command except `setup`, `status`, `cli …` and `help` refuses and says so.

The same things one at a time, if you prefer:

```bash
# 1. the repo, checked out on its base branch
git clone git@github.com:you/roster-service.git ~/repos/roster-service

# 2. AI accounts: CLI logins run the provider's login in your terminal; API keys are stored
consort-cli accounts add --provider claude --name work
consort-cli accounts add --provider codex --name work
consort-cli accounts add --provider claude --name billing --api-key sk-ant-…
consort-cli accounts list

# 3. Slack: a bot token (xoxb-…) with chat:write, im:write and im:history (channels:history if you use --channel); reinstall the app after adding a scope. And your member id.
consort-cli slack set --bot-token xoxb-… --user U0123ABC
consort-cli slack test                      # posts a hello into your DM

# 4. trackers
consort-cli clickup set-key pk_…
consort-cli prefix set bot                  # branches become bot/<slug>-<ticket id>

# 5. a scanner: one place to watch, how often, which tickets qualify; each match goes to a worker agent
consort-cli scanners add --name roster --source clickup --space 90131945617 \   # or --list <id> / --folder <id>
  --repo ~/repos/roster-service --base main \
  --tag ai-handle --status "to do" --every 1
consort-cli scanners scan <scanner id>      # dry run: which tickets would be taken
```

A ClickUp scanner watches one list, a folder, or a whole space (every list in it, folderless and in folders); paste the sidebar URL into the wizard (`/v/li/…`, `/v/f/…`, `/v/s/…`) and it works out which. A space or folder is scanned with one workspace-wide search (the tag filter applied by ClickUp), so a space of hundreds of lists costs a few requests a minute, not hundreds; ClickUp allows 100. Tasks are matched by tag, status and title across all those lists, and each task's status moves within its own list's statuses. GitHub issues work the same with `--source github` and no list; filters apply to labels and the issue title. Every filter must hold: `--tag` (any of), `--status` (any of), `--name-includes` (all), `--name-excludes`, `--assignee`.

## Run

```bash
consort-cli run
```

Keep it running under `systemd`, `tmux` or `nohup`. Every `--every` minutes (1 by default) it runs each scanner, skips tickets another consort-cli has claimed (a `[consort-claim host=… at=…]` comment on the ticket, honoured for three days), claims up to `--max-parallel` new ones, and starts a worker process per ticket. Workers that die are restarted at the next pass; `consort-cli status` shows them, `consort-cli tasks logs <task>` shows a worker's log.

## What a worker does

1. Cuts `bot/<slug>-<id>` from `origin/<base>` into `~/.consort-cli/worktrees/<slug>-<id>`, writes `.consort/ship/TICKET.md`, opens a Slack thread for the ticket and moves its status to *in progress*.
1. **Its own environment.** The task gets a Docker run code (`consort-<task>`, used as the compose project name, container name prefix and `io.consort.run` label) and a block of 100 ports no other live task on the box holds: the app on the first, Postgres at +10, Redis at +11, Mongo at +12, MySQL at +13, and so on. Every agent turn runs with these in its shell and is told the rules: only these ports and names, never the defaults, overrides in `.consort/env/.env.consort` rather than tracked files. The first turn works out what running the repo locally takes (compose files, Dockerfile, env examples, scripts, migrations, seeds), writes `.consort/ship/ENV.md` with the real commands on this task's ports, plus `.consort/env/up.sh` and `down.sh`, and proves they work. The test session and the evidence step use them. When the task ends, everything Docker holds under the code is removed (`tasks release` does the same).
2. **Grilling, headless.** The agent reads the ticket and the code, decides everything straightforward itself and lists those as Assumptions in the spec. Only material open questions reach you: a Slack message in the thread, numbered, each with a recommended answer. Reply in the thread; one message is enough. The worker waits as long as it takes.
3. **Implementing.** Tickets from the spec, built, committed, pushed; a draft PR. Then the test session proves every story and writes the report. The worker approves on your behalf and marks the PR ready.
4. **Three review rounds.** Consort's own PR review, each round on a different model: Codex's strongest, then Claude's strongest, then the next Claude family down (configurable with `--review-models`). After each round the builder fixes what is real and pushes.
5. **Evidence.** Before anyone is asked to review, the agent proves the feature works and Consort posts the proof on the PR and on the ticket, each linking to the other. A feature with a frontend gets a local database seeded with data that exercises it, the app started, and screenshots of the feature in use (via headless Chrome; `consort-cli setup` checks for one, or set `CONSORT_CHROME`). Anything else gets the commands, database queries and API calls that prove it, kept as text and rendered as terminal images too. Images are hosted as ClickUp task attachments when the ticket is a ClickUp task, else on an orphan `consort-evidence` branch in the repo (they render inline on public repos; on private ones the links open for people with access).
6. **Reviewers.** The people who touched the changed files most are requested on the PR.
7. **The watch.** Every 15 minutes the worker reads the PR. New review threads from humans are answered: clear requests are fixed, pushed, replied to and resolved; anything unclear or disputed gets one neutral reply and a Slack question to you. CI and approvals are read each pass.
8. **Ready.** One human approval, no changes requested, no open threads, CI green: you get a Slack message with the PR link and the ticket gets a final comment. Merging is yours.

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
| `scanners add …` / `scanners list` / `scanners scan <id>` / `scanners enable\|disable <id>` / `scanners remove <id>` | a scanner watches one place and hands matches to worker agents (`jobs …` still works) |
| `run` | the daemon |
| `tasks list` / `tasks logs <id>` / `tasks release <id>` | release stops the worker and forgets the claim locally |
| `cli status` / `cli update` | the Claude Code and Codex binaries |
| `status` | one line per live task |
| `export [--out f] [--scanner id]` / `import <file>` / `accounts login <id>` | move scanners to another machine |

## Moving scanners to another machine

```bash
consort-cli export                          # writes consort-cli-<host>-<date>.json, mode 600
consort-cli export --scanner roster --out roster.json
# on the other box, after installing consort-cli:
consort-cli import roster.json [--repo-dir ~/repos] [--replace]
```

The file holds everything the scanners need: the ClickUp token, Slack, the branch prefix, every account (API keys, and the login's credential file where there is one), and every scanner with its repo's `origin` URL. Import fills in what the box lacks, clones each repo it does not have (under `~/.consort-cli/repos` unless `--repo-dir` says otherwise), skips accounts and scanners with the same name, and marks setup done so `consort-cli run` works at once. `--replace` overwrites the token, Slack and prefix with the file's. Claude Code logins made on a Mac live in the Keychain, not in a file, so those accounts arrive without credentials; import names them and `consort-cli accounts login <id>` signs them in. Work in flight stays where it started. The file is secrets in plain text: move it privately and delete it after.

## Accounts and usage limits

Add as many accounts per provider as you have (`accounts add` once per login or key). A task sticks to one account per provider; when that account hits a usage limit the worker blocks it until the provider's reset time (or an hour when it does not say), says so in the Slack thread, and continues on the least recently used account of the same provider, starting a fresh session (the stage handlers pick up from the files on disk). With every account of a provider out, the worker waits for the first to free up. `accounts list` shows blocks; `accounts unblock <id>` clears one by hand.

Nothing asks for permission: Claude Code runs with permissions bypassed and Codex with approvals off and full access on the box, so run consort-cli on a machine you dedicate to it. Both agents may search and read the web for research.

## Watching it

```bash
consort-cli view
```

A live table: ticket, title, stage, status, the account in use, how long it has run, and what the worker is doing right now. Finished tasks stay for two hours, then drop off. Below it, the accounts, each with its plan meters as bars (5-hour, weekly, and one per model family, like the desktop's Usage panel; amber from 80%, red from 95%), when the 5-hour window resets, and any block; then the scanners with their next scan. Usage is read once a minute by asking each login's own CLI, with no model call; API-key accounts have no meters. `--once` prints one frame (`--no-usage` skips the read). `q` quits.

## Limits of this cut

- Model lists are the seed lists; pass `--review-models` to name others.
- Slack is polled, not pushed, so an answer is seen within about 10 seconds.
- A ticket released with `tasks release` keeps its claim comment on the tracker; delete it there if another box should take it.
