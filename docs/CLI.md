# consort-cli

Consort's ship pipeline with no window: a daemon on a Linux or macOS box that watches a ClickUp list or a repo's issues, claims the tickets that match, and ships each one in its own worktree. Questions reach you on Slack; everything else it decides and records. It never merges.

## Install

For a new server, follow the [Linux worker setup checklist](LINUX-SETUP.md) first: host tools, GitHub authentication, Docker, browser evidence, credentials, and reboot persistence.

```bash
git clone https://github.com/mitchmeyer1/consort-ade.git && cd consort-ade
pnpm install --frozen-lockfile --ignore-scripts # skips the Electron and node-pty builds the desktop app needs
pnpm build:cli
npm link --ignore-scripts          # or: alias consort-cli="node $PWD/out/cli/index.js"
```

Needs Node 22.12+, git, and the GitHub CLI (`gh auth login`) for PRs and issues. The Claude Code and Codex binaries come with the install as platform packages; `consort-cli cli update` fetches newer ones.

State lives in `~/.consort-cli/state.json` (mode 600; it holds API keys), logins in `~/.consort-cli/logins/<account>/`, worktrees in `~/.consort-cli/worktrees/`, logs in `~/.consort-cli/logs/`. Set `CONSORT_CLI_HOME` to move it.

## Sentry ticket producer

A third scanner type, `sentry`, groups unresolved Sentry issues and creates tagged ClickUp tickets in a setup-selected list (or a selected list inside a folder). It does not start workers. Align a ClickUp worker scanner with that destination and tag to implement the tickets later. See [Sentry routing and duplicate protection](SENTRY-SCANNER.md).

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
consort-cli run -d        # in the background; log in ~/.consort-cli/logs/daemon.log
consort-cli run           # in this terminal, ctrl-c to stop
consort-cli stop          # the daemon; agents keep working and the next run adopts them
consort-cli stop --all    # the daemon and every agent; their tasks resume on the next run
```

For a daemon that survives reboots, run it under `systemd` or `launchd`. Every `--every` minutes (1 by default) it runs each scanner, skips tickets another consort-cli has claimed, claims up to `--max-parallel` new ones, and starts a worker process per ticket. Workers that die are restarted at the next pass; `consort-cli status` shows them, `consort-cli tasks logs <task>` shows a worker's log.

## What a worker does

1. Cuts `bot/<slug>-<id>` from `origin/<base>` into `~/.consort-cli/worktrees/<slug>-<id>`, writes `.consort/ship/TICKET.md`, opens a Slack thread for the ticket and moves its status to *in progress*.
1. **Its own environment.** The task gets a Docker run code (`consort-<task>`, used as the compose project name, container name prefix and `io.consort.run` label) and a block of 100 ports no other live task on the box holds: the app on the first, Postgres at +10, Redis at +11, Mongo at +12, MySQL at +13, and so on. Every agent turn runs with these in its shell and is told the rules: only these ports and names, never the defaults, overrides in `.consort/env/.env.consort` rather than tracked files. The first turn works out what running the repo locally takes (compose files, Dockerfile, env examples, scripts, migrations, seeds), writes `.consort/ship/ENV.md` with the real commands on this task's ports, plus `.consort/env/up.sh` and `down.sh`, and proves they work. The test session and the evidence step use them. When the task ends, everything Docker holds under the code is removed (`tasks release` does the same).
2. **Grilling, headless.** The agent reads the ticket and the code, decides everything straightforward itself and lists those as Assumptions in the spec. Only material open questions reach you: a Slack message in the thread, numbered, each with a recommended answer. Reply in the thread; one message is enough. The worker waits as long as it takes.
3. **Implementing.** Tickets from the spec, built, committed, pushed; a draft PR. Then the test session proves every story and writes the report. The worker approves on your behalf and marks the PR ready.
4. **Three review rounds.** Consort's own PR review, each round on a different model: Codex's strongest, then Claude's strongest, then the next Claude family down (configurable with `--review-models`). After each round the builder fixes what is real and pushes.
5. **Evidence.** Before anyone is asked to review, the agent proves the feature works and Consort posts the proof on the PR and on the ticket, each linking to the other. A feature with a frontend gets a local database seeded with data that exercises it, the app started, and screenshots of the feature in use (via headless Chrome; `consort-cli setup` checks for one, or set `CONSORT_CHROME`). Anything else gets the commands, database queries and API calls that prove it, kept as text and rendered as terminal images too. Images are hosted as ClickUp task attachments when the ticket is a ClickUp task, else on an orphan `consort-evidence` branch in the repo (they render inline on public repos; on private ones the links open for people with access).
6. **Reviewers.** The people who touched the changed files most are requested on the PR.
7. **The watch.** Every three minutes the worker reads the PR. New review threads from humans are answered: clear requests are fixed, pushed, replied to and resolved; proven incorrect, stale, or already satisfied requests receive an evidence-backed reply and are resolved without a Slack question; real ambiguity or decisions get a Slack question. CI and approvals are read each pass.
8. **Ready.** One selected human reviewer approved, no changes requested, no open threads, CI green: you get a Slack message with the PR link and the ticket gets a final comment. Merging is yours.

### Claims, with many boxes

A claim is a comment on the ticket: `[consort-claim host=<name> at=<time>]`, where the name is this install's hostname plus a random suffix minted once (so two laptops called the same thing, or two installs on one box, never collide; `CONSORT_CLI_HOST` overrides it). Before claiming, a scanner reads the comments and skips a ticket with a fresh marker (under three days old) from another install. Because the tracker has no lock, two installs can still post within the same second, so after posting its marker each one reads the ticket again: the earliest fresh marker wins, the loser deletes its own and moves on, and only the winner moves the status to *in progress*. A marker older than three days is abandoned work and is ignored; `tasks release` leaves the marker, so delete it on the ticket if another box should take the ticket sooner.

Every stage move is posted to the Slack thread and as a comment on the ticket; the ticket status moves to *in review* when the PR is up and to *complete* if the PR is merged while the worker is still watching.

Starts, stops, pauses, resumes, and completion are posted only inside the existing ticket thread. Each ticket has one root message; questions, updates, retries, and worker restarts reuse its saved thread. Replies never broadcast to the channel feed. An immediate account/model fallback stays running and does not send pause/resume alerts. Exhausting all accounts sends one pause alert; recovery sends a separate resume alert. Questions pause until your reply, including after a worker restart. Waiting on human reviews or CI sends a pause alert; new feedback resumes work.

## Which model does what

Two tiers per provider, read off what the provider offers (`src/shared/modelTiers.ts`). The strongest model (Claude Fable, Codex Astra) does the thinking: grilling, the spec, the review rounds, and the check that the evidence proves the acceptance criteria. The tier below it (Claude Opus, Codex Sol) does the execution, which is nearly all of the tokens: the local environment, the build (Implementing, Ready to Test, Revising), the fixes after each review round, the evidence gathering, review-comment replies and CI repairs. When a turn falls over to the other provider it keeps its tier. The task log's first lines name both models.

## Slack messages you will see

- `Picked up <title>. Working on branch …` — the thread opens.
- `→ Spec'd — Spec written headless in 1 round.` — a stage moved.
- `I need you on 2 things …` — answer in the thread.
- `Review round 2 on claude-fable-5-1: 4 findings, fixing the real ones.`
- `Asked @ada, @grace to review.`
- `Ready to merge. Approved, no open threads, CI green: <PR>` — done.
- `❌ Stuck at <stage>` / `❌ Evidence blocked. PR not handed off` — the stop report. Every stop (a turn past its time limit, three turns without progress, a failed evidence check, a crash, a broken PR watch) posts the same shape: one line on what went wrong, the reasons as bullets, the agent's last lines (`Last seen`, `Before that`), what was already retried, the raw error in a code block, and one line on how to reply. Reply in the thread; the task stays open. `consort-cli tasks logs <task>` has the full log.

## Commands

| Command | Does |
|---|---|
| `accounts add --provider claude\|codex --name <label> [--api-key k]` | add an account; without a key runs the CLI login |
| `accounts list` / `accounts remove <id>` | |
| `slack set --bot-token … --user … [--channel …]` / `slack test` | |
| `clickup set-key <key>` / `prefix set <prefix>` | |
| `scanners add …` / `scanners list` / `scanners scan <id>` / `scanners enable\|disable <id>` / `scanners remove <id>` | a scanner watches one place and hands matches to worker agents (`jobs …` still works) |
| `run [-d]` / `stop [--all]` | the daemon, in the foreground or detached; stop it, or it and the agents |
| `tasks list` / `tasks logs <id>` / `tasks release <id>` / `tasks retry <id>` | by task id or ticket id; release stops the worker and forgets the claim locally; retry relaunches a failed one |
| `reboot <id>` / `reboot --all` | stop that ticket's agent (or every live one) and start it again; any open question is dropped and the first turn works out where the last run got to (git state, PR, half-done edits) before continuing |
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

Add as many accounts per provider as you have (`accounts add` once per login or key). A task sticks to one account per provider; when that account hits a usage limit the worker blocks it until the provider's reset time (or an hour when it does not say), logs the switch, and continues on the least recently used account of the same provider, starting a fresh session (the stage handlers pick up from the files on disk). With every account of a provider out, the worker tries the other provider with its own model and session. Only when neither provider has a usable account does the worker wait; it checks again every 30 seconds, including for newly added accounts. `accounts list` shows blocks; `accounts unblock <id>` clears one by hand.

Nothing asks for permission: Claude Code runs with permissions bypassed and Codex with approvals off and full access on the box, so run consort-cli on a machine you dedicate to it. Both agents may search and read the web for research.

## Watching it

```bash
consort-cli view
```

A live table (header says whether the daemon is running): ticket, title, the step it is on as `n/9` (environment, grilling, build, test, one review per model in the rotation, evidence, watch PR), the step's name, the step that comes next, status, the account in use, what it has cost so far (estimated dollars and total tokens over every agent turn; Claude Code prices its own turns, Codex turns are priced from the table in `src/shared/headless.ts`), how long it has run, and what the worker is doing right now. Finished tasks stay for 24 hours, then drop off. The same cost line is printed with the evidence on the PR and the ticket. Below it, the accounts, each with its plan meters as bars (5-hour, weekly, and one per model family, like the desktop's Usage panel; amber from 80%, red from 95%), when the 5-hour window resets, and any block; then the scanners with their next scan, and the commands that stop the daemon or one agent. Usage is read once a minute by asking each login's own CLI, with no model call; API-key accounts have no meters. `--once` prints one frame (`--no-usage` skips the read). `q` quits.

STATUS shows green `RUNNING` while the worker is active, yellow `WAITING` for a Slack reply, human PR review, or CI, and red `STOPPED` when the task failed or its worker is gone. Yellow `LIMIT` means the worker is waiting for account usage to reset; yellow `STALLED` means no activity for ten minutes. Bright blue `COMPLETED` means three internal reviews are finished, two human reviewers were requested, one selected reviewer approved, every thread is resolved, and CI passed. Consort never merges. ACTIVITY shows the reason. A usage limit can leave a worker alive and waiting, so it does not by itself mean the task failed.

## Limits of this cut

- Model lists are the seed lists; pass `--review-models` to name others.
- Slack is polled, not pushed, so an answer is seen within about 10 seconds.
- A ticket released with `tasks release` keeps its claim comment on the tracker; delete it there if another box should take it.


### Evidence must pass before human review

The worker requires a manifest with every acceptance check passed, matching captures/output, and no blockers. Frontend changes require screenshots of the working feature. A separate agent inspects the actual files against the ticket and spec before publication. Missing/empty images, failed uploads, or a failed PR/ticket comment block completion. The worker marks evidence complete only after validation, inspection, and publication to both destinations succeed. Older evidence timestamps without this validation are rechecked when a worker resumes.

If evidence fails, the worker pauses and asks the owner on Slack what is needed, then retries after the reply. A capture or inspection that runs beyond fifteen minutes is stopped and escalated to Slack. The owner's reply does not waive acceptance checks. Error pages, missing map tiles, missing API keys, and partially working flows must be fixed and captured again.

For a missing credential, the agent names the exact variable and the repository-root env file on the Consort machine. The owner adds the key there and confirms in Slack. Only then may the agent copy that specific variable into the worktree's appropriate ignored env file, preserving unrelated settings, restart the app, and rerun the flow. Secret values must never be sent through Slack, printed, captured, or committed.


### Scanner countdown and status log

The scanner row refreshes every second with `next scan in MM:SS`, `due now`, or `scanning · MM:SS elapsed`. A completed or failed scan starts the next countdown. Disabled scanners show `off`.

Below Scanners, Status log shows only the newest eight events in time order: scan starts, checked/new/claimed task counts, no new tasks, full worker capacity, scan failures, Slack checks with no answer, Slack check failures, and answers found for a named ticket. Blue shows scan progress/results, green shows claims and answers, yellow shows waiting, and red shows failures. Unchanged Slack waits appear at most once per minute per waiting task; answers and changed check results appear immediately. Reply contents stay out of this log. Events persist across dashboard restarts in the CLI log directory's `status.jsonl`.


### Contributor reviewers and batched feedback

After three internal review rounds and working evidence, Consort suggests and requests two reviewers using real GitHub contributor accounts. Contributors to the changed files come first; other repository contributors fill remaining slots by contribution count. Bots and the PR author are excluded. If GitHub cannot identify two eligible reviewers or rejects a request, Consort asks the owner in the ticket's existing Slack thread.

PR checks run every three minutes. New unresolved threads and review comments wait as one batch until their contents stay unchanged for at least three minutes. New replies, edits, replacement comments, or resolved threads restart that wait even when the count stays the same. The pending batch survives worker restarts. Once quiet, Consort fixes the batch, runs checks, commits and pushes, then replies and resolves addressed threads. Unclear requests go to Slack. Consort rereads GitHub after the fix; threads still unresolved remain eligible for the next batch. It requests another review and keeps watching until approval and passing CI. Consort never merges.


### Final completion rule

The worker stays in the review/CI loop until at least one saved reviewer username has a current GitHub approval, GitHub has no outstanding review requirement or requested changes, every review thread is resolved, and CI has passed. One selected reviewer approval satisfies Consort; an approval from a different person does not. Empty, unknown, or pending CI results block completion. GitHub treats skipped/neutral checks as non-failing; failures, cancelled checks, stale checks, and startup failures trigger repair.

There is no build-turn cutoff. Unrecoverable agent errors ask the owner in the existing Slack thread and resume after the answer. Four repeated process crashes also ask Slack instead of permanently failing the task. Provider capacity waits still resume when credits refill. Waiting for reviewers or CI keeps polling without an owner response. When all completion checks pass, STATUS becomes bright blue COMPLETED, ready for the owner to merge. Consort never merges.


### Small AI API costs

Live AI API calls for implementation, tests, and evidence are pre-authorized when their combined additional cost for the task is conservatively estimated below USD 1.00. The worker counts planned calls, retries, and earlier calls together, bounds request/output sizes, and records the estimate locally. It asks on Slack if the total may reach USD 1.00 or cannot be bounded. This is agent guidance, not an enforced provider billing cap.

Within that allowance, the worker may use an existing required API key from the repository-root env file and copy only the named variable into the worktree's appropriate ignored env file without another confirmation. Secret values never belong in logs, screenshots, Slack, or commits. A missing key still requires the owner to add it on the Consort machine. Material business/security decisions and plan upgrades still require an answer.


Slack message markers: ✅ marks progress updates, starts, and resumes; ⏳ means waiting (on your reply, reviews, CI, or credits); ❓ is a question for you; ⏹️ means stopped on purpose and resuming on the next run; ❌ means something broke and needs a hand. 🎉🍭🎊 marks only the completed ready-to-merge handoff after one selected reviewer approves, threads are resolved, and CI passes. Messages stay in the ticket's existing thread.

Every Slack ticket message ends with `STATUS: RUNNING`, `STATUS: WAITING`, `STATUS: STOPPED`, or `STATUS: COMPLETED`. Credit waits, questions, and review/CI waits show WAITING; resumes show RUNNING. Queued lifecycle messages retain the status of the transition they describe. COMPLETED is the ready-to-merge handoff; Consort never merges.

Ticket Slack messages show only the blue link labels `ticket` and `github` immediately above STATUS. The ticket link opens the source ticket; GitHub opens the PR once available, otherwise the task branch on the origin GitHub repository.

Evidence comments on GitHub and the ticket list start time, end time (when evidence is verified and ready to publish), and elapsed duration immediately below agent cost. Times use UTC; duration includes credit and Slack waits, and ends before the human-review/CI watch.

Ask “How’s this going?”, “What’s the status?”, or “Any updates?” in a ticket’s Slack thread. While the daemon runs, it checks every 15 seconds and replies with one sentence containing the saved current action and pipeline step, followed by ticket/GitHub links and STATUS. Status questions never resume a blocked worker or count as answers to its questions. Only the configured owner can request these updates. New listeners check the last ten minutes for unanswered questions; replies use saved task state without an AI call.

Worker stop diagnostics record the Consort command, requesting process ID, target worker, and timestamp before sending SIGTERM. Reboot holds daemon replacement until the old worker has exited and the task reset is saved. The daemon rechecks the current task immediately before spawning; an old worker's exit callback cannot change a replacement's status. Signals without a recorded Consort stop request are reported as external, without guessing their sender.

Every ticket Slack message begins with the ticket's saved emoji and short title so Slack's recents identify the task. At worker startup, AI picks one topic emoji and preserves an already concise title or shortens it to at most five words. The heading is reused across restarts and all ticket updates, above the update emoji, links, and STATUS. When no account is available or generation fails, a temporary 📋 heading keeps messages identifiable; a later worker startup retries generation.

For objectively incorrect review requests, Consort verifies the current code and relevant executable checks, explains the evidence, and resolves the thread without changing correct code or asking the owner. For example, it retains generated routeCount 350 when regeneration proves 350, rather than setting 3500. Confidence alone is insufficient; missing or conflicting evidence and business/design/security decisions still pause on Slack.

PR waiting updates name selected reviewers, outstanding requested changes, CI state, the next three-minute check, and your next action. Consort re-requests missing reviews after feedback and retries missing requests at most every 30 minutes per commit. After one hour waiting, it asks you in the ticket thread to nudge the named reviewers. Resolving threads does not clear a reviewer’s changes-requested verdict; that reviewer must review again. Scanners find eligible tickets; workers independently handle code, review feedback, and CI.

Reviewer selection validates both saved and newly supplied GitHub logins against repository access. Slack answers must contain exactly two logins or two explicit @mentions; Consort does not extract words from prose. Every review-request write is followed by a GitHub read confirming the requested reviewers before Consort announces success. Invalid saved selections are replaced with validated contributor suggestions on worker startup.
