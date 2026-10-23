# Sentry → ClickUp scanner

The Sentry scanner produces tickets. It does not change Sentry issue status. Setup creates a linked ClickUp worker scanner that claims and implements its bundle tickets using the existing accounts and Slack connection.

## Configure in setup

Run `consort-cli setup`, add a scanner, and choose `sentry` as the source. Setup asks for:

1. A shared GitHub repository checkout and base branch for duplicate reservations. Every cooperating Sentry producer for this ClickUp workspace must use the same GitHub repository.
2. Sentry host, organization, project slugs, environments, query, and a secret auth token. The default host is https://sentry.io, query is `is:unresolved`, environment is production, and interval is fifteen minutes. Use a token with organization issue access (`event:read`), not an ingestion DSN.
3. A ClickUp token and workspace accessible to it. The token must be able to see all tasks that should participate in duplicate detection.
4. A destination list or folder. For a folder, explicitly select the list inside it that receives tickets; ClickUp tasks belong to lists, not directly to folders.
5. An output tag and the list's initial task status. Both are configurable; there is no hard-coded Aligned list or tag.

Setup verifies read access and the chosen list/workspace, but creates no tickets. Bundle planning reuses saved Claude Code/Codex accounts, and setup asks for one only if none is configured. The saved Slack connection and ClickUp token are reused. Setup also reuses an existing Sentry token for the same repository and suggests the existing ClickUp worker’s destination, tag, and status. Sentry tokens live in the mode-600 CLI state file and are included in secret-bearing scanner exports.

## Suggested routing

Create/select a dedicated **Sentry Inbox** list inside whichever engineering folder you want. Use an output tag such as **sentry** and an initial status such as **to do**. Setup configures a dedicated linked worker for that list and tag; no second manual worker configuration is needed. You can instead select **ai-handle** if that is already the worker scanner's tag. Choose these during setup rather than changing code.

Example:

- Sentry producer: project node, production, destination Sentry Inbox, tag sentry, initial status to do.
- ClickUp worker: watches the engineering folder containing Sentry Inbox, tag sentry, status to do.

The producer creates the ticket on a scan. The linked ClickUp worker claims it on its next scan, using the existing multi-worker claim protocol.

## CLI configuration

Configure the ClickUp key through setup first. Set SENTRY_AUTH_TOKEN in the launching shell without writing its value into shell history. Replace the sample repository path, project, workspace, list, tag, and status below with your actual settings:

```bash
consort-cli scanners add --name "Sentry intake" --source sentry \
  --repo /path/to/shared/repository --base main \
  --sentry-org your-org --sentry-project node \
  --environment production --query is:unresolved \
  --workspace 123456 --list 234567 --tag sentry \
  --create-status "to do" --every 15 --max-parallel 1
```

Multiple projects/environments can be comma-separated. For folder routing, setup is preferable because it lists and validates child lists; CLI configuration can pass both the selected list and its `--folder` ID.

`consort-cli scanners scan <id>` is a read-only preview: issue/group counts, already-ticketed groups, and how many tickets would be created. `consort-cli run -d` runs the producer on schedule. The dashboard scanner row and eight-line status log show Sentry scan results separately from worker tasks. No ticket is created until the producer actually runs.

## Grouping

Sentry already groups events into issues. Consort first fetches every page matching the configured projects, environments, and query. It forms exact diagnostic groups, then uses one existing Consort AI account to consider the complete scan and read relevant repository code before publishing any ticket. Different errors and projects may enter one **Sentry bundle** when evidence points to a shared real bug. Similar wording alone is insufficient; unrelated reports stay separate.

The planner must assign every input group exactly once and explain each bundle. Missing, invented, or repeated groups, a failed AI turn, exhausted accounts, or an input too large to inspect in full stop ticket creation. No sample or truncated scan creates work. The scanner retries on its next scheduled scan after credits recover. Planning can use existing subscription logins or API keys and incurs normal provider usage; no second credentials or Slack connection is created.

Each bundle creates one ClickUp ticket containing the shared-cause explanation and every related issue ID/link, count, location, and first/last-seen time. The linked, concurrency-limited ClickUp worker scanner claims that ticket using normal multi-worker deduplication, then uses the existing accounts, Slack task thread, review pipeline, and evidence checks. The worker must still reproduce and confirm the cause before implementing. Sentry diagnostic text is untrusted; credentials are not included in planner input or tickets.

## Duplicate protection

Before creation, the producer enumerates accessible ClickUp tasks across the chosen workspace, including closed tasks and subtasks, without restricting tags, lists, or scanner ownership. It matches a durable group marker, Sentry issue URLs, or issue short IDs. Existing tickets from other scanners/agents are therefore respected when they contain those references. Closed matching tickets are not duplicated or reopened automatically. New reports for an existing referenced bundle are appended to that ticket, preserving its existing description, instead of creating another implementation task.

For simultaneous cooperating producers, the winner atomically creates a deterministic GitHub reference under `refs/heads/consort-sentry/<hash>`. Reservations cover the bundle and every individual Sentry issue, using workspace, organization, and host identity rather than scanner name, list, or tag. Per-issue reservations prevent concurrent producers from creating overlapping bundles even if their AI grouping differs. The producer rechecks ClickUp after winning, then creates one ticket. These reservation branches point at the configured base commit and contain no token or issue payload. The GitHub credential needs permission to create references.

A failed search never falls back to creating blindly. An ambiguous creation timeout, missing task ID, or existing reservation without a visible ticket blocks another creation. The status log reports reserved groups for reconciliation. This favors avoiding duplicates over automatic retries after ambiguous writes.

All cooperating producers must use the same reservation repository. ClickUp visibility limits apply: an inaccessible task cannot be detected. An unrelated agent that creates a ticket concurrently without this protocol can still race the producer; ClickUp's task-create API does not provide an atomic workspace-wide uniqueness constraint. Existing tickets without a group marker or Sentry reference cannot be reliably matched by meaning alone.

### Reconcile an orphan reservation

If a reservation exists without a ticket, first inspect the full workspace and stop other producers for that bundle and its issue IDs. The previous request may have created a task despite its timeout. If you find the task, keep the reservation and its Sentry references. Only after confirming no task exists should an operator remove that exact reservation reference and rerun the scan. Consort never automatically removes reservations or deletes tickets. GitHub branch rules must allow this namespace; normal cleanup tooling must leave these references alone.

## Existing Aligned logic reviewed

The implementation follows the existing `SentryClient` shape in `aligned-mono/packages/core/src/services/clients/sentry.client.ts` and its `sentry-daily.cron.ts` production/development digest. Those components read unresolved issues and post Slack digests; they do not create or deduplicate ClickUp tickets. The new scanner adds routing and ticket production in Consort without changing that service or cron.

The new scanner uses the supported [Sentry organization issues API](https://docs.sentry.io/api/events/list-an-organizations-issues/), [ClickUp workspace task search](https://developer.clickup.com/reference/getfilteredteamtasks), [ClickUp task creation](https://developer.clickup.com/reference/createtask), and [GitHub reference creation](https://docs.github.com/en/rest/git/refs#create-a-reference).

## Limit active Sentry tickets

Setup asks “How many Sentry tickets may be worked on at once?” Default: **1**. Enter a positive whole number; CLI configuration uses `--max-parallel N`.

This is a whole-ticket limit, not merely an AI-turn limit. Queued tickets, builds, user-answer waits, credit waits, PR review, and CI monitoring consume slots. Ready-to-merge, done, and released tasks free slots; failed tasks keep their slot pending recovery. A full scanner checks capacity without fetching Sentry or running the AI bundle planner. When a slot is free, the next scheduled scan considers all matching reports together but creates only enough bundle tickets to fill the free slots. Deferred bundles are left unreserved for a later scan.

The linked worker has the same open-ticket, AI-turn, and environment limits. Bundle tickets carry the producer identity; broader ClickUp scanners on this installation skip them so they cannot bypass the cap. Existing producer-only setups gain a linked worker when the daemon restarts, defaulting to one slot. Existing workers already running are not terminated by a reduced limit. Cooperating installations should use the same scanner configuration; global multi-machine capacity is not an atomic workspace-wide semaphore.
