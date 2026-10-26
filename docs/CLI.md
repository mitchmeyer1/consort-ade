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

State lives in `~/.consort-cli/state.json` (mode 600; it holds account API keys, never the covered key, which stays in the Keychain or a file the PHI/PII guard points at), logins in `~/.consort-cli/logins/<account>/`, worktrees in `~/.consort-cli/worktrees/`, logs in `~/.consort-cli/logs/`. Set `CONSORT_CLI_HOME` to move it.

## Sentry ticket producer

A third scanner type, `sentry`, groups unresolved Sentry issues and creates tagged ClickUp tickets in a setup-selected list (or a selected list inside a folder). It does not start workers. Align a ClickUp worker scanner with that destination and tag to implement the tickets later. See [Sentry routing and duplicate protection](SENTRY-SCANNER.md).

## Set up, once

```bash
consort-cli setup
```

The walk-through does everything below in order and tests each piece as it goes: the tools on the box (git, a signed-in `gh`, the Claude Code and Codex binaries), the issue sources (a ClickUp key checked against the API, the list looked up so you pick statuses from its own names, or a GitHub repo checked with `gh`), the repository path and base branch (verified on origin), optional project info resources (each checked as a git checkout that is not a scanner's repository), the AI accounts (each CLI login into this tool's own directory, separate from Consort desktop; API keys checked against the provider), the PHI/PII guard and where the covered key lives (see [PHI/PII guard](#phipii-guard)), Slack (a DM is sent and you confirm it arrived), and the permissions it needs (worktree directory writable, `git push --dry-run` to origin, the ClickUp list readable). Every step saves, so you can stop and rerun. On a rerun each step shows what is saved (scanners, the ClickUp token, branch prefix, accounts, Slack; secrets masked) and `y` or Enter keeps it, `n` replaces it or, for a scanner or account, removes it. Until it finishes, every command except `setup`, `status`, `cli …` and `help` refuses and says so.

The same things one at a time, if you prefer:

```bash
# 1. the repo, checked out on its base branch
git clone git@github.com:you/roster-service.git ~/repos/roster-service

# 2. AI accounts: CLI logins run the provider's login in your terminal; API keys are stored
consort-cli accounts add --provider claude --name work
consort-cli accounts add --provider codex --name work
consort-cli accounts add --provider claude --name billing --api-key sk-ant-…
consort-cli accounts list

# 3. Slack: a bot token (xoxb-…) with chat:write, im:write, im:history and files:read (channels:history if you use --channel); reinstall the app after adding a scope. And your member id.
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

# 6. project info resources (optional): notes Grilling reads
consort-cli resources add --name team-notes --markdown ~/notes/team-vault
```

**Project info resources (optional).** A resource is a local git checkout of your team's markdown notes: decisions, processes and gotchas about the systems your tickets touch (a team second brain or vault). Add one in setup, which asks right after the scanners, or with `consort-cli resources add --name team-notes --markdown ~/notes/team-vault`; `resources list` and `resources remove <id or name>` manage them. A resource must be a git checkout other than any scanner's repository. Every resource is used by every task: at each worker start Consort runs `git pull --ff-only` in it (a failure is logged and the checkout is read as it is), and during Grilling one reader per resource reads it and reports the notes that bear on the ticket, with their paths and dates, to the planner. The reader runs on the reader model at low effort with its working directory in the checkout: read-only (Claude plan mode, Codex read-only sandbox), with web search and fetch off, and without loading the notes repository's own Claude settings, CLAUDE.md or MCP servers. Nothing is written into a resource, and the agents that plan and build never see its path, only the report. **Point a resource only at notes whose contents may be quoted in PRs, Slack and ticket comments: no patient or personal data, no secrets. Consort cannot check that; keeping the notes clean is yours.**

A ClickUp scanner watches one list, a folder, or a whole space (every list in it, folderless and in folders); paste the sidebar URL into the wizard (`/v/li/…`, `/v/f/…`, `/v/s/…`) and it works out which. A space or folder is scanned with one workspace-wide search (the tag filter applied by ClickUp), so a space of hundreds of lists costs a few requests a minute, not hundreds; ClickUp allows 100. Tasks are matched by tag, status and title across all those lists, and each task's status moves within its own list's statuses. Subtasks are scanned too, so a tag on a subtask alone picks up that subtask. To change a scanner's filters later, edit `~/.consort-cli/state.json` (the `jobs[].filters` block) while the daemon is stopped, then start it again; no need to run setup again. GitHub issues work the same with `--source github` and no list; filters apply to labels and the issue title. Every filter must hold: `--tag` (any of), `--status` (any of), `--name-includes` (all), `--name-excludes`, `--assignee`.

## Run

```bash
consort-cli run -d        # in the background; log in ~/.consort-cli/logs/daemon.log
consort-cli run           # in this terminal, ctrl-c to stop
consort-cli stop          # the daemon; agents keep working and the next run adopts them
consort-cli stop --all    # the daemon and every agent; their tasks resume on the next run
```

For a daemon that survives reboots, run it under `systemd` or `launchd`. Every `--every` minutes (1 by default) it runs each scanner, skips tickets another consort-cli has claimed, claims up to the open-task limit, and starts a worker process per ticket. `--max-parallel` limits active AI work; Slack waits and GitHub monitoring do not hold an AI slot. Separate account, installation, and environment limits bound resource use. Workers that die are restarted at the next pass; `consort-cli status` shows them, `consort-cli tasks logs <task>` shows a worker's log.

## What a worker does

1. Cuts `bot/<slug>-<id>` from `origin/<base>` into `~/.consort-cli/worktrees/<slug>-<id>`, writes `.consort/ship/TICKET.md`, opens a Slack thread for the ticket and moves its status to *in progress*.
1. **Its own environment.** The task gets a Docker run code (`consort-<task>`, used as the compose project name, container name prefix and `io.consort.run` label) and a block of 100 ports no other live task on the box holds: the app on the first, Postgres at +10, Redis at +11, Mongo at +12, MySQL at +13, and so on. Every agent turn runs with these in its shell and is told the rules: only these ports and names, never the defaults, overrides in `.consort/env/.env.consort` rather than tracked files. The first turn works out what running the repo locally takes (compose files, Dockerfile, env examples, scripts, migrations, seeds), writes `.consort/ship/ENV.md` with the real commands on this task's ports, plus `.consort/env/up.sh` and `down.sh`, and proves they work. The test session and the evidence step use them. When the task ends, everything Docker holds under the code is removed (`tasks release` does the same).
2. **Grilling, headless.** The agent reads the ticket and the code, decides everything straightforward itself and lists those as Assumptions in the spec. With project info resources configured it also gets a report on each: something a note settles becomes an Assumption citing the note instead of a question, and where the ticket asks for something a later dated decision settled otherwise, the question names both, with the date, instead of recommending the ticket's version. Only material open questions reach you: a Slack message in the thread, numbered, each with a recommended answer. Reply in the thread; one message is enough. The worker waits as long as it takes. Before the spec is written the agent runs an impact check: it traces what the change touches and, if it would break an existing flow that still serves a business purpose, asks "We can do this, but it would break <flow>. Proceed?" with a recommendation, and waits for your answer. The outcome lands under "Impact check" in the spec.
3. **Implementing.** Tickets from the spec, built, committed, pushed; a draft PR. Then the test session proves every story and writes the report. The worker approves on your behalf and marks the PR ready.
4. **One review per provider.** With both providers configured: one Fable review followed by fixes, then one Astra review followed by fixes. With only one provider: one review. A review waits for its own provider when credits are exhausted. Legacy `--review-models` can select an offered release within the Fable/Astra family; it cannot add an Opus round. Review readers use the cheap reader model; each review reserves capacity for its one foreground reader. With capacity of one, the reviewer reads directly.
5. **Evidence.** Before anyone is asked to review, the agent proves the feature works and Consort posts the proof on the PR and on the ticket, each linking to the other. A feature with a frontend gets a local database seeded with data that exercises it, the app started, and screenshots of the feature in use (via headless Chrome; `consort-cli setup` checks for one, or set `CONSORT_CHROME`). Anything else gets the commands, database queries and API calls that prove it, kept as text and rendered as terminal images too. Images are hosted as ClickUp task attachments when the ticket is a ClickUp task, else on an orphan `consort-evidence` branch in the repo (they render inline on public repos; on private ones the links open for people with access).
6. **Reviewers.** The people who touched the changed files most are requested on the PR.
7. **The watch.** Every three minutes the worker reads the PR. New review threads from humans are answered: clear requests are fixed, pushed, replied to and resolved; proven incorrect, stale, or already satisfied requests receive an evidence-backed reply and are resolved without a Slack question; real ambiguity or decisions get a Slack question. CI and approvals are read each pass.
8. **Ready.** One selected human reviewer approved, no changes requested, no open threads, CI green: you get a Slack message with the PR link and the ticket gets a final comment. Merging is yours.

### Claims, with many boxes

A claim is a comment on the ticket: `[consort-claim host=<name> at=<time>]`, where the name is this install's hostname plus a random suffix minted once (so two laptops called the same thing, or two installs on one box, never collide; `CONSORT_CLI_HOST` overrides it). Before claiming, a scanner reads the comments and skips a ticket with a fresh marker (under three days old) from another install. Because the tracker has no lock, two installs can still post within the same second, so after posting its marker each one reads the ticket again: the earliest fresh marker wins, the loser deletes its own and moves on, and only the winner moves the status to *in progress*. A marker older than three days is abandoned work and is ignored; `tasks release` leaves the marker, so delete it on the ticket if another box should take the ticket sooner.

Every stage move is posted to the Slack thread and as a comment on the ticket; the ticket status moves to *in review* when the PR is up and to *complete* if the PR is merged while the worker is still watching.

Starts, stops, pauses, resumes, and completion are posted only inside the existing ticket thread. Each ticket has one root message; questions, updates, retries, and worker restarts reuse its saved thread. Replies never broadcast to the channel feed. An immediate account/model fallback stays running and does not send pause/resume alerts. Exhausting all accounts sends one pause alert; recovery sends a separate resume alert. Questions pause until your reply, including after a worker restart. Waiting on human reviews or CI sends a pause alert; new feedback resumes work.

## Which model does what

CLI models are selected by job role in `src/shared/cliModels.ts`; desktop model tiers are separate. Codex delegate models and limits use the [official agents configuration settings](https://learn.chatgpt.com/docs/config-file/config-reference).

| Role | Default | Work |
| --- | --- | --- |
| planning | Fable / Astra | Grilling, spec, recovery |
| implementation | Opus / Sol | Environment, build, repairs, evidence gathering |
| coordination | Sonnet / Sol | Independent evidence inspection |
| reader | Haiku / Luna | Scoped research and review reading |
| frontier | Fable / Astra | Required PR reviews and escalated analysis |

Defaults select matching models from the CLI seed catalog. A configured role can name a supported newer release explicitly; account access must exist. Provider fallback preserves the job role. An agent can request frontier analysis with `[model-escalate: reason]`; two failed ordinary attempts also escalate by default. Owner decisions still use Slack questions. Frontier failures stop for recovery rather than retrying without a bound. Every attempted turn records its role, model, elapsed execution time, usage, error and escalation reason in `tasks[].turnHistory`; limit attempts retain returned usage. Estimated API cost is separate from subscription quota. Unknown model prices remain visibly unpriced.

Each role also carries a reasoning effort. Readers run at `low` and frontier turns at `high`. For the build, the planner decides: the spec ends with `[build-effort: low|medium|high|xhigh|max — reason]`, weighing how much of the codebase the change touches, whether it crosses systems or includes a migration or unfamiliar code, how many stories the spec has and what the impact check found. The implementation and coordination turns then run at that level, the thread gets a `Build effort: high · reason` line, and `tasks[].plannedEffort` records it. Nobody is asked. `scanners configure` takes `--<role>-effort low|medium|high|xhigh|max` for any of the five roles when an owner wants to pin one; precedence is the scanner's flag, then the planner's level, then the role default (`medium`). Codex has no `max` and runs `xhigh` for it. The task log's first lines name the planning and build efforts beside their models, every `tasks[].turnHistory` entry records the effort it ran at, and the dashboard's TURN column shows the model and effort of the turn in flight.

Configure existing scanners without setup:

```sh
consort-cli scanners configure <scanner-id> \
  --planning-model claude:claude-sonnet-5 \
  --planning-model codex:gpt-6.1-sol \
  --implementation-model codex:gpt-6.1-sol \
  --reader-model codex:gpt-6-luna \
  --max-model-attempts 2 \
  --planning-effort high --implementation-effort medium \
  --parallel-research 2 --parallel-implementation 2 \
  --max-parallel 2 --max-open-tasks 8 --max-environments 8
consort-cli accounts configure <account-id> --max-active-turns 2
consort-cli capacity configure --max-active-turns 4 --max-open-tasks 32 --max-environments 16
```

Use the supported model IDs available to the configured accounts. Omitted settings retain their defaults. Repeating a role flag configures both providers. All capacity values must be positive integers. Parallel readers/writers are capped at two; selecting one runs research serially and keeps implementation on the coordinator path.

## Parallel research and implementation

During grilling, Consort schedules business-flow tracing, test discovery, and integration/schema research through the same capacity gates as every other turn. Readers use isolated worktrees and read-only model permissions. Reports live under `.consort/ship/parallel/`; reuse requires matching task prompts and file revisions, including changes outside each reader's assigned scope. The planning model combines reports and asks business-impact questions before the spec. With project info resources, one more reader per resource runs alongside them, in the resource checkout itself rather than a worktree: read-only, offline, and without the notes repository's own Claude settings. Its report goes to `.consort/ship/parallel/RESOURCES.md` and reaches the planner under "Prior decisions (project info resources)"; it is reused while the checkout's commit, its uncommitted edits, the ticket text and the reader's prompt are unchanged. A resource that cannot be read is logged and left out; the task goes on.

The CLI yields after creating the ticket breakdown so the runtime can schedule ready tickets. Every parallel ticket needs explicit `Files`, `Blocked by`, and `Status` fields. Every ready ticket with disjoint files and satisfied dependencies runs together, up to the wave size below, including within one package. Each writer gets a detached worktree, its own ports and Docker code, the spec and owner decisions, and local dependency setup. The coordinator validates file ownership, integrates commits, and runs checks. A journal records landed commits so a restarted worker does not rebuild finished tickets. Writers never share the coordinator's session or index. Work without safe scopes stays serial; a full environment limit also falls back to serial work.

Defaults allow two active AI units per scanner and per account, four installation-wide, eight open tasks per scanner (or four times its active limit if larger), 32 installation-wide open tasks, and 16 installation-wide environments. A scanner's environment limit defaults to its open-task limit. Parent and writer environments both count. Waiting tasks keep their environment until cleanup, but consume no AI unit. State updates use a cross-process lock and merge unrelated stale-snapshot edits so parallel workers retain each other's changes. Crashed AI leases are reclaimed; child Docker resources are cleaned on completion or recovery.

Slack headings use a local formatter, so naming a task consumes no model call. Export/import preserves role and capacity settings. Building the CLI updates the bundle for new workers; an existing daemon must restart to use the new scanner scheduler, and an already running worker retains its loaded code.

## Slack messages you will see

- `Picked up <title>. Working on branch …` — the thread opens.
- `→ Spec'd — Spec written headless in 1 round.` — a stage moved.
- `I need you on 2 things …` — answer in the thread.
- `Review round 2 on gpt-6-astra: 4 findings, fixing the real ones.`
- `Asked @ada, @grace to review.`
- `Ready to merge. Approved, no open threads, CI green: <PR>` — done.
- `⚠️ PII gate: <what> carried ssn ×1. Withheld; nothing was sent.` / `⚠️ Message withheld by the PII gate (dob ×1).` / `⚠️ The ticket carries 2 identifiers the PII gate masks` — the PHI/PII guard stopped or masked something (see [PHI/PII guard](#phipii-guard)).
- `❌ Stuck at <stage>` / `❌ Evidence blocked. PR not handed off` — the stop report. Every stop (a turn past its time limit, three turns without progress, a failed evidence check, a crash, a broken PR watch) posts the same shape: one line on what went wrong, the reasons as bullets, the agent's last lines (`Last seen`, `Before that`), what was already retried, the raw error in a code block, and one line on how to reply. Reply in the thread; the task stays open. `consort-cli tasks logs <task>` has the full log.

### Spreading work across accounts

Claude and Codex are interchangeable: each new agent goes to whichever account, on either provider, has the most room for that kind of turn (for frontier work, Fable's meter against Astra's; otherwise the plan-wide meters). An account that errors is skipped for the rest of that turn, so the retry runs on another account, Claude or Codex. A network error (for example ENOTFOUND) does not count as a model failure. A frontier turn asks the owner only after it has failed on every usable account.

Each new agent (a fresh session, a review, a parallel worker, the oversight agent) goes to the account with the least usage for its model. Code reads each account's plan meters and decides; no AI is involved. A frontier call (Fable, Astra) compares the plan-wide windows plus that model's own window. Other calls (Opus, Sonnet, Sol) compare the plan-wide windows plus their model's window if the plan has one. Accounts whose model window is spent are skipped; ties go to the account used longest ago. A turn that resumes a session stays on that session's account. Usage is cached in `~/.consort-cli/usage-cache.json` for 2 minutes, shared by the view, the daemon and the workers. The worker log shows each choice, for example `claude-sonnet-5 on Idle; claude use for this model: Busy 85%, Idle 12%`.

### Progress saved on GitHub

After every step before the PR (each grilling, spec and build turn), the worker commits whatever the agent left uncommitted in the task's worktree and pushes the task branch to `origin`. Commit messages look like `Consort checkpoint: Implementing (Build 9/18)`. `.env`, `.pem` and `.key` files are never staged; `.consort/` is already excluded. Checkpoints skip git hooks so a slow pre-commit or pre-push check cannot stall the worker; the real checks still run before the PR. A failed push is logged and retried after the next step. With the PHI/PII guard on, a push the PII gate withholds stays committed locally, and the next turn is told which lines to rewrite.

### Draft PR from the start

As soon as a task has its branch, the worker opens a draft PR titled `[WIP] <ticket title>`, so the Slack "github" link shows the diff, the commits and a summary. GitHub needs one commit first, so a branch with none gets an empty `Consort: start …` commit. The description says the PR is not ready for review and carries the ticket link, the current step (for example `Implementing (Build 9/18)`) and the ticket text; the worker refreshes it at each checkpoint. When the build is done, the agent reuses this PR: it drops `[WIP]` and writes the real description instead of opening a second PR. An open PR that already exists for the branch is reused.

### Build graph and waves

The turn that writes the build plan (the first turn with a spec and no tickets yet) and any re-split run on the frontier model (Fable or Astra), because that plan decides how much of the build can run at once. It splits by objective and code area, not by the ClickUp subtasks; the subtasks are tracked separately. Each parallel ticket gets 90 minutes (saved every 5, so a timeout resumes). A ticket that fails or edits outside its files is held back while the rest of its wave is integrated. The coordinator no longer builds tickets a wave can run; it builds only one that cannot run in parallel and otherwise fixes what the last wave left. When a wave starts, Slack gets `Building N tickets in parallel: …` and the linked ClickUp subtasks move to in progress.

The spec step plans the build as a dependency graph of objectives, grouped by the code they live in, not by the order of the ticket's subtasks. Shared contracts (types, interfaces, schema, stub clients) go in one small first ticket so the tickets that use them can run side by side. Before each build step the worker reads `.consort/ship/issues/` and works out the waves in code: every ticket whose blockers are done starts together, up to the job's `parallelImplementation` (default: the job's `maxParallel`, at most 6), each in its own worktree beside the task's worktree. Slack gets a `Build plan: 7 tickets left in 3 waves, up to 4 at once` line when the ticket set changes, with any cycles, unknown blockers or shared files called out. A graph that is mostly a chain (at least six tickets left, fewer than two per wave) gets one re-split turn: the agent rewrites the unfinished tickets for parallel work without touching finished ones. `consort-cli tasks split <ticket>` asks for that re-split on demand, for a build already under way: it stops the worker, which restarts, rewrites the unfinished tickets by objective, and builds them in waves. Child worktrees left by a stopped wave are saved, then removed, when the worker recovers.

### ClickUp subtasks follow the build

When the ClickUp task has subtasks, the worker saves them to `.consort/ship/SUBTASKS.md` and each build ticket names the subtasks it delivers on a `**ClickUp:**` line (tickets planned before this get one linking turn). After every step, the worker moves each linked subtask forward, never back: **in progress** once any of its tickets starts, **in review** once all of them are built, **complete** when the PR merges. Each move comments on the subtask with the tickets and the commit, and the parent task gets one `Consort progress: 3 of 8 subtasks built` comment per step that moved something. A subtask no build ticket names is left alone.

### Parallel work is never thrown away

Each parallel ticket commits in its own worktree as it goes, and the worker saves it every 5 minutes: the ticket's work is committed and kept under `refs/consort/wip/<ticket>` and pushed to GitHub as `consort-wip/<branch>/<ticket>`. The same save happens when a child fails (usage limit, a question for you, edits outside its files), when the worker is stopped (`stop --all`, `tasks reboot`, `tasks split`, the box shutting down), and when a stopped wave's leftover folders are cleaned up. The next run of that ticket starts from the saved work; the saved ref and branch are removed once the ticket is integrated. `tasks reboot` and `tasks split` refuse while a parallel wave is running unless you add `--force`. Each ticket that lands also comments on the ClickUp subtasks it serves.

### Build progress

The spec step splits the build into tickets under `.consort/ship/issues/`, each with a `Status:` line. While a task is building, `consort-cli view` and the Slack status line show how many are done, for example `Build 8/18`. Each task in `consort-cli view` takes three lines: the table row, what the worker is doing now at full width, and a blank line.

### Talking to the bot in the Slack thread

Every message you post in a task's thread gets a real answer while the worker keeps going, except a "thanks" or the answer to a question the worker asked. While the worker waits on you, a reply that asks something back (it ends in "?", or starts with "what", "why", "how" and the like and contains one) is a question, not your answer: the agent explains what is being asked and the options, adds "Still waiting on your answer to the question above", and the worker keeps waiting for a plain reply. A review's approval takes only a yes or a no. The `consort-cli run` process starts a read-only oversight agent for each message: Opus on Claude, Sol on Codex (override with the job's `modelPolicy.coordination`). It reads the worker log, turn timings, task state, recent ClickUp or GitHub comments, the thread, and the worktree, then replies. It doesn't take an AI slot from the workers. If the agent is down, you get the saved status line.

When your message asks for a change, or carries files (needs the `files:read` scope), it is also queued for the worker. Files are saved under `.consort/ship/updates/<ts>/` in the worktree. Between steps the worker runs one agent turn that rewrites the ticket and changes the code to match. It then replaces the ClickUp or GitHub issue description, attaches the files, comments on the ticket, and replies in Slack. A change posted on a task that is ready to merge reopens it; a closed task says it can't apply it.

### Updating Consort

After pulling new Consort code, run `consort-cli refresh` (or `consort-cli refresh --pull` to pull first). It installs dependencies when the lockfile changed, rebuilds the CLI, then stops the daemon and every worker, waits for each to save and exit, and starts the daemon again on the new build; the daemon restarts each open task's worker within 15 seconds. A failed install or build leaves everything running as it was. It will not restart while a parallel wave is running unless you add `--force` (the wave's work is saved and resumes). Reopen any `consort-cli view` window afterwards.

### Automatic PR reviews

A review scanner reviews other people's PRs:

```bash
consort-cli scanners add review
```

It asks for the repository checkout, your GitHub login (your `gh` login is the default), a name, and how many PRs to review at once (default 1). `consort-cli scanners add clickup` and `consort-cli scanners add sentry` ask the same questions `setup` does for those scanners. The `--source …` flags still work for scripts. Every 5 minutes it lists the repository's open PRs that request that login's review; being assigned to a PR does not count, and drafts and that login's own PRs are skipped. GitHub drops the request once the review is posted, so a PR comes back for another review when the author asks you again. Each PR head gets one review task; new commits get a new review. The worker:

1. checks the PR head out in its own worktree, copies the repo root's `.env` files in (not `.env.example`), and sets up databases and services like a build task;
2. has Fable or Astra read the repository, its conventions, `.ai-review-rules.md` and the diff, and write `.consort/review/OVERVIEW.md` and a plan of review areas;
3. runs one read-only reviewer per area on Opus or Sol, in parallel (up to the scanner's `--max-parallel`, default 4), each crawling its files, their callers and similar code for bugs, scaling problems and convention breaks;
4. has Fable or Astra verify every finding against the code, merge duplicates and settle severities (a rule in `.ai-review-rules.md` wins), saved as a standard `.review.json` (also under `~/.consort-cli/reviews/`);
5. posts one GitHub review. Any Critical or High finding: **Request changes**. Otherwise it posts the comments, then asks you in the review's Slack thread with a TL;DR, the findings and the link, and approves only when you reply yes.

A review is finished only when you approve or the PR is merged or closed. After Request changes, or when you reply anything but yes, the task watches the PR every two minutes (the status card shows 🔵 Waiting on the author's fixes). When the author asks for your review again, it runs another round at the new head: the earlier findings go to `.consort/review/previous.json`, the verify step checks each one first, and anything not fixed comes back as "Still open". Each round's files are kept under `.consort/review/round-N/`.

A review scanner reuses what the box already has: the Claude and Codex accounts (with the same usage balancing and turn limits), the Slack bot and thread handling (including the question-answering agent), the `gh` login (reviews post as that user; setup shows which), and the model settings of a build scanner on the same repository when the review scanner has none. Its environment turn starts from the repository's saved setup: after any task on a repository proves its environment, `ENV.md` and the scripts are kept under `~/.consort-cli/repo-env/` and the next build or review task adapts them to its own ports instead of re-reading the repository. Without Slack, reviews still comment and request changes but never approve; `scanners add` and `setup` say so.

### Agent log and post-mortems

Every agent turn (build stages, parallel tickets, self-reviews, environment setup, PR reviews, the Slack question agent, Sentry bundle planning) appends one line to `~/.consort-cli/telemetry/turns-YYYY-MM.jsonl`: ticket, scanner, step (for example `Implementing t4`, `parallel ticket 08`, `review area s3`), model, provider and account, start and duration, input/output/cache tokens and dollars, and the outcome (`ok`, `error`, `limit`, `timeout`, `silenced`, `aborted`) with its error. The log outlives the task.

`consort-cli report <ticket>` turns it into a post-mortem: wall clock against total agent time (how parallel the build really was), cost and tokens by stage, model, account and parallel ticket, the turns that did not finish, and the slowest turns. `consort-cli report --since 7d` covers every ticket. Each report prints and is saved under `~/.consort-cli/reports/`. Turns from before the log existed come from the task's saved history (without the account).

## Commands

| Command | Does |
|---|---|
| `accounts add --provider claude\|codex --name <label> [--api-key k]` | add an account; without a key runs the CLI login |
| `accounts list` / `accounts remove <id>` | |
| `slack set --bot-token … --user … [--channel …]` / `slack test` | |
| `clickup set-key <key>` / `prefix set <prefix>` | |
| `scanners add …` / `scanners list` / `scanners scan <id>` / `scanners enable\|disable <id>` / `scanners remove <id>` | a scanner watches one place and hands matches to worker agents (`jobs …` still works) |
| `resources add --name <n> --markdown <path>` / `resources list` / `resources remove <id or name>` | project info resources: notes checkouts every Grilling reads |
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

The file holds everything the scanners need: the ClickUp token, Slack, the branch prefix, every account (API keys, and the login's credential file where there is one), every scanner with its repo's `origin` URL, and every project info resource with its path and `origin` URL. Import fills in what the box lacks, clones each repo and resource it does not have (under `~/.consort-cli/repos` unless `--repo-dir` says otherwise), skips accounts, scanners and resources with the same name, and marks setup done so `consort-cli run` works at once. A resource that is neither on the box nor clonable is left out, and import says how to add it by hand; tasks run without it. `--replace` overwrites the token, Slack and prefix with the file's. Claude Code logins made on a Mac live in the Keychain, not in a file, so those accounts arrive without credentials; import names them and `consort-cli accounts login <id>` signs them in. Work in flight stays where it started. The file is secrets in plain text: move it privately and delete it after.

## Accounts and usage limits

Add as many accounts per provider as you have (`accounts add` once per login or key). A task sticks to one account per provider; when that account hits a usage limit the worker blocks it until the provider's reset time (or an hour when it does not say), logs the switch, and continues on the least recently used account of the same provider, starting a fresh session (the stage handlers pick up from the files on disk). With every account of a provider out, the worker tries the other provider with its own model and session. Only when neither provider has a usable account does the worker wait; it checks again every 30 seconds, including for newly added accounts. `accounts list` shows blocks; `accounts unblock <id>` clears one by hand.

Nothing asks for permission: Claude Code runs with permissions bypassed and Codex with approvals off and full access on the box, so run consort-cli on a machine you dedicate to it. Both agents may search and read the web for research.

## PHI/PII guard

The organisation's BAA with Anthropic covers its API key, not Claude subscriptions, and OpenAI has none. With the guard on, no subscription or Codex session reads member-level data: member-data questions go to one covered turn on the API key, and only an answer that passed a PII gate comes back. Turn it on in setup (step 5) or with `consort-cli phi guard on`.

**What changes with the guard on.**
- Every turn starts with the member-data rules: the ladder (aggregates; then deriving over identifier columns without selecting them; then hashed identifiers inside predicates or joins only; then the covered analyst), schema discovery as the agent's own work, warehouses read-only, tests and evidence from the task's seeded local database only, and no personal data in anything that leaves the machine.
- Codex accounts sit idle for every turn (build, review, oversight). Codex has no hook that can refuse a command before it runs, and OpenAI has no BAA with the organisation, so a Codex turn can be neither guarded nor covered. `accounts list` marks them, and review rotation is Claude-only.
- Every Claude turn runs under the guard's hooks, with no MCP servers, and everything Consort itself sends or receives passes the PII gate (see **Enforcement** below).
- An agent that needs member data writes one line, `[covered-analyst: <question>; tables: <db.schema.table, …>; shape: <the aggregate you want back>]`, and ends its turn. The worker runs the covered analyst and starts the agent's next turn with "Covered analyst answer": the gated answer, or "withheld by the PII gate (ssn ×1)" with an instruction to narrow the question, or why the analyst is unavailable. Logs record the outcome and categories only. Released answers are kept in `.consort/ship/COVERED.md`; a withheld or unavailable answer is posted to the thread as a ⚠️ line.

**The covered analyst.** One Claude turn, the only session allowed to read member-level data. It runs in a scratch folder under `~/.consort-cli`, removed afterwards, with only Bash. Its hook lets through one granted warehouse command at a time: no pipes, redirects, chains or background runs, and a read-only statement after `-q` over the tables the question named. It has no web, no file tools, no MCP servers, no settings from anywhere, no saved transcript, and its own empty Claude config, so it cannot fall back to a subscription login. It is told to answer in the requested shape only, suppress cells under 11, bin ages 90 and over, cut ZIP codes to three digits, and end with the SQL it ran. Its final message is scanned before anything else sees it by `src/shared/piiGate.ts`, a port of the organisation's pii-gate: SSN, payment card, Medicare beneficiary identifier, medical record number, email outside the internal domains, phone, labelled date of birth and street address block it, and pasted rows are a warning. On any finding nothing is released. Names have no shape to check, so `redactPii` masks those in what is released.

**Enforcement.** In every uncovered Claude turn, Agent SDK hooks in the worker's own process check each tool call before it runs (`src/cli/phiHooks.ts`), and the worker gates its own posts. A refusal reaches the agent as the tool's result, with the reason and what to do instead. A Bash line is read command by command, each unwrapped to the program it runs, so a runner (`env`, `command`, `exec`, `xargs`, `time`, `timeout`, `nohup`), a full path or a `sh -c` string changes nothing.

| Where | What is refused or changed | What the agent is told |
|---|---|---|
| Bash: keys | printing the environment, aliases or functions (`env`, `printenv`, `export -p`, `set`, `alias`, `type`, `which`, `command -v`), expanding a `*_API_KEY` or covered variable except in `[ -n "$NAME" ]`, any indirect expansion (`${!name}`), Keychain reads, shell startup files, Claude Code's shell snapshots, Consort's `state.json`, `secrets/` and `logins/` (a glob or brace pattern counts when it could match one), and a recursive read over the home folder | how to check a tool (`--version`) or a variable (`[ -n "$NAME" ]`) instead |
| Bash: warehouse commands (`snow`, `snowsql`, `hex`, plus `--warehouse-commands`) | a statement Consort cannot read (a file, piped or redirected input, a variable, a substitution); any write; any query that would bring an identifier column's value back. The query check is a port of the organisation's query guard: a mention of an identifier column is allowed only inside a counting aggregate or a predicate (`count_if(ssn is null)`, `where dob >= …`, `join … on`, `case when`), and a wildcard beside one, or over a person table, is unbounded. SQL comments are read as a space. `--identifier-columns` and `--person-tables` add to the baselines in `src/shared/warehouse.ts` and cannot remove one | reformulate at count or predicate level, then ask the covered analyst |
| Bash: text leaving the machine | `gh pr`/`issue`/`release` posts and `gh api` writes whose text or `--body-file`/`--input` file carries an identifier; a body read from a pipe or built by a substitution (the `$(cat <<'EOF' … EOF)` heredoc form is fine); a post or push that is not first on its line, or runs in the background, since a command before it could change what is sent after the check; curl and wget uploads to anything but this machine; `scp`, `sftp`, `rsync` to a host; gists and release assets | remove the personal data, pass the text in a file, or run the command on its own |
| Bash: `git push` | any commit the push sends that no remote-tracking branch has, whose message or added lines carry an identifier, commit by commit, lockfiles skipped; the commit posture lets published placeholders through. A push names what it sends (`git push`, a branch, `HEAD:…`); `--all`, `--tags` and `--mirror` are refused, and so is any git alias | rewrite the unpushed commits with placeholders (example.com, 555-01xx, sequential digits) |
| Read, Grep, Glob | shell startup files, shell snapshots, Consort's secrets, and files named like `member_data`, `phi-export` or `patient_records`; a search rooted at the home folder or above | — |
| After a warehouse command or an MCP tool | identifiers in the output become `[REDACTED:<category>]` and common names `****`; output the gate cannot read (an image, an unknown shape) is withheld | rewrite the query at count or predicate level |

The worker gates its own doors the same way. Slack messages are masked, and one that carries an identifier is replaced by a ⚠️ notice. A ticket comment, ticket description or attachment that carries one is not posted, and neither is an attachment that is neither text nor an image. The draft PR leaves out a ticket description that carries one. Evidence text is checked before any upload or comment; evidence that carries one is recaptured twice without asking you, then you are asked. An automatic review that carries one is not posted, and the review thread says so. Checkpoint, draft-PR and parallel-ticket pushes run the push check. Coming in, the ticket, its subtasks, your Slack answers and updates, review comments the worker answers, and Sentry reports turned into tickets are masked before an agent reads them.

A finding of a checksummed, positional or labelled identifier (SSN, card, MBI, MRN, labelled date of birth, labelled or E.164 phone) is an incident: one line in `~/.consort-cli/logs/phi-incidents.jsonl` (mode 600: time, what was gated, task, ticket, categories and masked shapes such as `ssn:NNN-NN-NNNN`, never the text), and a ⚠️ line in the task's thread naming the compliance contact when one is set. `phi incidents` lists them.

What the guard cannot see: a query run through a script (`python -c`, a connector in code) rather than a warehouse command, the output of Hex cells that run on Hex's servers, what a running app under test sends, images (evidence screenshots are held to the seeded local database by the rules, not by a scan), and names, which have no shape to check beyond the common-name list. These rest on the rules every turn carries.

**The covered key.** Consort never reads or stores it. State keeps a reference: a macOS Keychain item (`phi key ref --keychain`, service `anthropic-phi-api-key` by default) or a file only you can read (`phi key ref --file <path>`, chmod 600, the way on Linux). The covered turn's own Claude Code fetches the key through an `apiKeyHelper` command, and the turn stops unless the session reports that helper as its credential. So the key is in no environment variable, and nothing falls back: no key, no covered turn. `phi key store` puts a key in the Keychain; `security` asks for it, so Consort never sees it.

There is deliberately no environment-variable reference: a key exported in a variable reaches every process that inherits it. For the same reason Consort removes `COVERED_ANTHROPIC_API_KEY` and `CLAUDE_PII_COVERED` from every other agent's environment, and `phi status` checks whether your shell startup files put one back. zsh reads `~/.zshenv` for every shell, the agents' included, so an export there undoes the removal inside each agent's own shell. Export and import carry the reference and the guard's settings, never the key.

| Command | Does |
|---|---|
| `phi status` | guard on or off, where the key is (never its value), what an agent's shell gets from your startup files |
| `phi guard on\|off` | switch the guard; restart the daemon to apply it to running workers |
| `phi key ref --keychain [service] [--account a]` / `--file <path>` / `phi key store` / `phi key clear` | point at the key, put it in the Keychain, or forget the reference |
| `phi configure …` | `--grant` (the analyst's commands), `--warehouse-commands`, `--identifier-columns` and `--person-tables` (added to the query guard's baselines), `--domains` (internal email), `--contact` (compliance contact), `--model`, `--min-cell`, `--max-active` (covered turns at once; one by default, on its own capacity lease) |
| `phi smoke [--echo-shape]` | one covered turn: `released: ready`, or with `--echo-shape` a made-up identifier shape the gate must withhold |
| `phi smoke --uncovered --command "<cmd>"` | the hook's decision on the command, then one uncovered turn asked to run it; use a query that returns no rows (`… where 1=0`), so a broken guard reads nothing |
| `phi incidents [--last N]` | the incident log's latest entries |

The first covered turn on a Mac may show a Keychain access prompt for `security`; choose Always Allow so later turns do not wait on it.

## Watching it

```bash
consort-cli view
```

A live table (header says whether the daemon is running): ticket, title, the step it is on as `n/9` (environment, grilling, build, test, one review per model in the rotation, evidence, watch PR), the step's name, the step that comes next, status, the account in use, the model and effort of the turn in flight (TURN), what it has cost so far (estimated dollars and total tokens over every agent turn; Claude Code prices its own turns, Codex turns are priced from the table in `src/shared/headless.ts`), how long it has run, and what the worker is doing right now. Finished tasks stay for 24 hours, then drop off. The same cost line is printed with the evidence on the PR and the ticket. Below it, the accounts, each with its plan meters as bars (5-hour, weekly, and one per model family, like the desktop's Usage panel; amber from 80%, red from 95%), when the 5-hour window resets, and any block; then the scanners with their next scan, and the commands that stop the daemon or one agent. Usage is read once a minute by asking each login's own CLI, with no model call; API-key accounts have no meters. `--once` prints one frame (`--no-usage` skips the read). `q` quits.

STATUS shows green `RUNNING` while the worker is active, yellow `WAITING` for a required owner Slack reply; PR review and CI monitoring remain green `RUNNING`, and red `STOPPED` when the task failed or its worker is gone. Yellow `LIMIT` means the worker is waiting for account usage to reset; yellow `STALLED` means no activity for ten minutes. Bright blue `COMPLETED` means three internal reviews are finished, two human reviewers were requested, one selected reviewer approved, every thread is resolved, and CI passed. Consort never merges. ACTIVITY shows the reason. A usage limit can leave a worker alive and waiting, so it does not by itself mean the task failed.

## Limits of this cut

- Model lists are the seed lists; pass `--review-models` to name others.
- Slack is polled, not pushed, so an answer is seen within about 10 seconds.
- A ticket released with `tasks release` keeps its claim comment on the tracker; delete it there if another box should take it.


A live worker with no recent progress message remains RUNNING in the terminal and Slack. After ten minutes, the terminal warns that no progress message has arrived and explicitly says no owner action is needed. Silence alone does not prove a stall; the worker handles its timeout and recovery. WAITING means a question needs your reply.

### Evidence must pass before human review

The CLI keeps the PR in draft through local self-review rounds and evidence gathering. Only after verified evidence is published to both the PR and ticket does the CLI mark the PR ready and request external reviewers. Draft PRs remain visible, so unsolicited comments can still arrive before this handoff.

With the PHI/PII guard on, the evidence text passes the PII gate before anything is uploaded or posted. The worker requires a manifest with every acceptance check passed, matching captures/output, and no blockers. Frontend changes require screenshots of the working feature. A separate agent inspects the actual files against the ticket and spec before publication. Missing/empty images, failed uploads, or a failed PR/ticket comment block completion. The worker marks evidence complete only after validation, inspection, and publication to both destinations succeed. Older evidence timestamps without this validation are rechecked when a worker resumes.

If an acceptance check or a permanent publication error needs owner input, the worker pauses and asks the owner on Slack. Temporary publication network errors, rate limits, and server errors retry automatically with STATUS: RUNNING; capture and independent verification are not rerun for these retries. Successful image uploads and PR/ticket comments are recorded locally so later retries reuse them. Changed image contents require a fresh upload. A worker restart also clears the old generic evidence "fetch failed" question. Evidence gathering allows 90 minutes per turn; independent inspection allows 30 minutes. A timeout automatically resumes saved work up to twice, with a Slack update and no owner action required. Long-running tools do not trigger the shorter silence watchdog during these turns. After three timed-out attempts, the worker asks the owner whether to retry or pause rather than guessing that credentials are missing. Restarting a worker also clears the old fifteen-minute evidence timeout question and resumes evidence. The owner's reply does not waive acceptance checks. Error pages, missing map tiles, missing API keys, and partially working flows must be fixed and captured again.

For a missing credential, the agent names the exact variable and the repository-root env file on the Consort machine. The owner adds the key there and confirms in Slack. Only then may the agent copy that specific variable into the worktree's appropriate ignored env file, preserving unrelated settings, restart the app, and rerun the flow. Secret values must never be sent through Slack, printed, captured, or committed.


### Scanner countdown and status log

The scanner row refreshes every second with `next scan in MM:SS`, `due now`, or `scanning · MM:SS elapsed`. A completed or failed scan starts the next countdown. Disabled scanners show `off`.

Below Scanners, Status log shows only the newest eight events in time order: scan starts, checked/new/claimed task counts, no new tasks, full worker capacity, scan failures, Slack checks with no answer, Slack check failures, and answers found for a named ticket. Blue shows scan progress/results, green shows claims and answers, yellow shows waiting, and red shows failures. Unchanged Slack waits appear at most once per minute per waiting task; answers and changed check results appear immediately. Reply contents stay out of this log. Events persist across dashboard restarts in the CLI log directory's `status.jsonl`.


### Contributor reviewers and batched feedback

After three internal review rounds and working evidence, Consort suggests and requests two reviewers using real GitHub contributor accounts. Contributors to the changed files come first; other repository contributors fill remaining slots by contribution count. Bots and the PR author are excluded. If GitHub cannot identify two eligible reviewers or rejects a request, Consort asks the owner in the ticket's existing Slack thread.

PR checks run every three minutes. New unresolved threads and review comments wait as one batch until their contents stay unchanged for at least three minutes. New replies, edits, replacement comments, or resolved threads restart that wait even when the count stays the same. The pending batch survives worker restarts. Once quiet, Consort fixes the batch, runs checks, commits and pushes, then replies and resolves addressed threads. Unclear requests go to Slack. Consort rereads GitHub after the fix; threads still unresolved remain eligible for the next batch. It requests another review and keeps watching until approval and passing CI. A PR with merge conflicts is never handed off: Consort merges the base branch into the PR branch, resolves the conflicts, runs the checks, pushes, and waits for GitHub to report the branch clean; after three failed attempts it asks you. Consort never merges.


### Final completion rule

The worker stays in the review/CI loop until at least one saved reviewer username has a current GitHub approval, GitHub has no outstanding review requirement or requested changes, every review thread is resolved, and CI has passed. One selected reviewer approval satisfies Consort; an approval from a different person does not. Empty, unknown, or pending CI results block completion. GitHub treats skipped/neutral checks as non-failing; failures, cancelled checks, stale checks, and startup failures trigger repair.

There is no build-turn cutoff. Unrecoverable agent errors ask the owner in the existing Slack thread and resume after the answer. Four repeated process crashes also ask Slack instead of permanently failing the task. Provider capacity waits still resume when credits refill. Waiting for reviewers or CI keeps polling without an owner response. When all completion checks pass, STATUS becomes bright blue COMPLETED, ready for the owner to merge. Consort never merges.


### Small AI API costs

Live AI API calls for implementation, tests, and evidence are pre-authorized when their combined additional cost for the task is conservatively estimated below USD 1.00. The worker counts planned calls, retries, and earlier calls together, bounds request/output sizes, and records the estimate locally. It asks on Slack if the total may reach USD 1.00 or cannot be bounded. This is agent guidance, not an enforced provider billing cap.

Within that allowance, the worker may use an existing required API key from the repository-root env file and copy only the named variable into the worktree's appropriate ignored env file without another confirmation. Secret values never belong in logs, screenshots, Slack, or commits. A missing key still requires the owner to add it on the Consort machine. Material business/security decisions and plan upgrades still require an answer.


Slack message markers: ✅ marks progress updates, starts, and resumes; ⚠️ means it needs your reply in the thread; ⏳ means waiting (on reviews, CI, or credits); ❓ is a question for you; ⏹️ means stopped on purpose and resuming on the next run; ❌ means something broke and needs a hand. 🎉🍭🎊 marks only the completed ready-to-merge handoff after one selected reviewer approves, threads are resolved, and CI passes. Messages stay in the ticket's existing thread.

Every Slack ticket message ends with `STATUS: RUNNING`, `STATUS: WAITING`, `STATUS: STOPPED`, or `STATUS: COMPLETED`. Credit waits, questions, and review/CI waits show WAITING; resumes show RUNNING. Queued lifecycle messages retain the status of the transition they describe. COMPLETED is the ready-to-merge handoff; Consort never merges.

Ticket Slack messages show only the blue link labels `ticket` and `github` immediately above STATUS. The ticket link opens the source ticket; GitHub opens the PR once available, otherwise the task branch on the origin GitHub repository.

Evidence comments on GitHub and the ticket list start time, end time (when evidence is verified and ready to publish), and elapsed duration immediately below agent cost. Times use UTC; duration includes credit and Slack waits, and ends before the human-review/CI watch.

Ask “How’s this going?”, “What’s the status?”, or “Any updates?” in a ticket’s Slack thread. While the daemon runs, it checks every 15 seconds and replies with one sentence containing the saved current action and pipeline step, followed by ticket/GitHub links and STATUS. Status questions never resume a blocked worker or count as answers to its questions. Only the configured owner can request these updates. New listeners check the last ten minutes for unanswered questions; replies use saved task state without an AI call.

Worker stop diagnostics record the Consort command, requesting process ID, target worker, and timestamp before sending SIGTERM. Reboot holds daemon replacement until the old worker has exited and the task reset is saved. The daemon rechecks the current task immediately before spawning; an old worker's exit callback cannot change a replacement's status. Signals without a recorded Consort stop request are reported as external, without guessing their sender.

Every ticket Slack message begins with the ticket's saved emoji and short title so Slack's recents identify the task. At worker startup, AI picks one topic emoji and preserves an already concise title or shortens it to at most five words. The heading is reused across restarts and all ticket updates, above the update emoji, links, and STATUS. When no account is available or generation fails, a temporary 📋 heading keeps messages identifiable; a later worker startup retries generation.

For objectively incorrect review requests, Consort verifies the current code and relevant executable checks, explains the evidence, and resolves the thread without changing correct code or asking the owner. For example, it retains generated routeCount 350 when regeneration proves 350, rather than setting 3500. Confidence alone is insufficient; missing or conflicting evidence and business/design/security decisions still pause on Slack.

PR waiting updates name selected reviewers, outstanding requested changes, CI state, the next three-minute check, and your next action. Consort re-requests missing reviews after feedback and retries missing requests at most every 30 minutes per commit. After one hour waiting, it asks you in the ticket thread to nudge the named reviewers. Resolving threads does not clear a reviewer’s changes-requested verdict; that reviewer must review again. Scanners find eligible tickets; workers independently handle code, review feedback, and CI.

Reviewer selection validates both saved and newly supplied GitHub logins against repository access. Slack answers must contain exactly two logins or two explicit @mentions; Consort does not extract words from prose. Every review-request write is followed by a GitHub read confirming the requested reviewers before Consort announces success. Invalid saved selections are replaced with validated contributor suggestions on worker startup.

Reviewer suggestions rank Git blame owners of changed lines and their surrounding 20 lines on the merge base first. Overlapping ranges count once. GitHub commit authors map ordinary email addresses to real logins. Changed-file history, neighboring-directory history (including for new files), then repository contributors fill gaps. Consort selects two distinct humans, excludes the PR author and bots, validates repository access, and confirms GitHub recorded both review requests.

RUNNING means Consort owns the next action, including review polling, comment batching, merge-conflict follow-up, and CI checks. WAITING means Consort needs the owner’s Slack answer before continuing. Automatic credit-reset waits show LIMIT on the dashboard and RUNNING with the reset explanation in Slack. These automatic states no longer announce “Paused.”

Consort never re-requests review from anyone who previously approved that PR, including after fixes, merge-conflict resolution, new commits, or dismissed approvals. The GitHub request function checks review history immediately before every request and excludes approved and dismissed reviewers. Slack messages list only requests actually made. GitHub approval and CI completion requirements remain enforced.

### Slack master monitor

The daemon maintains one master monitor post in the configured Slack channel or DM, in addition to each ticket thread. It edits that root post in place and never posts replies beneath it. Working, the six most recent completed tasks, and cached account usage mirror the terminal overview. Each ticket title opens its own Slack conversation; ticket and GitHub links remain separate. Sentry preparation appears before its ClickUp ticket exists. The monitor refreshes from saved state every 15 seconds, edits only when its contents change, and saves its post identity across restarts. If the local identity is missing it finds the existing bot monitor in channel history before creating one. Monitor discovery needs the same conversation-history scope used by ticket replies.

Run `consort-cli slack monitor` to create or refresh the master post immediately without restarting ticket workers.

### Review speed and recovery

Review workers reserve an available eligible account before starting their execution timeout. The global, scanner and per-account limits still apply. Task turn history records `queueMs` separately from `executionMs`; `externalWaitMs` counts sleeps between PR/author checks.

Each successful review area is saved under the task worktree's `.consort/review/areas/` immediately. A restart reuses that area only when its PR head, base context, policy, scope and prompt match. Failed or malformed areas prevent approval and do not discard successful areas.

Repeat reviews compare against the last reviewed head and recheck previous findings, expanding to affected callers. A changed merge base, rebase, model/guard policy, or dependency/configuration file triggers a full pass. Changes of at most two files and 200 added/deleted lines use one reviewer when they do not touch configuration, authentication, migrations, schemas, payments or security. Small self-reviews inspect directly without a delegated reader. Required tests, findings verification and owner approval stay in place.
