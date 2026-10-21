# Sentry → ClickUp scanner

The Sentry scanner produces tickets. It does not claim work, change Sentry issue status, or start build/review agents. Existing ClickUp worker scanners pick up its tickets later when their list/folder/space, tag, and status filters match.

## Configure in setup

Run `consort-cli setup`, add a scanner, and choose `sentry` as the source. Setup asks for:

1. A shared GitHub repository checkout and base branch for duplicate reservations. Every cooperating Sentry producer for this ClickUp workspace must use the same GitHub repository.
2. Sentry host, organization, project slugs, environments, query, and a secret auth token. The default host is https://sentry.io, query is `is:unresolved`, environment is production, and interval is fifteen minutes. Use a token with organization issue access (`event:read`), not an ingestion DSN.
3. A ClickUp token and workspace accessible to it. The token must be able to see all tasks that should participate in duplicate detection.
4. A destination list or folder. For a folder, explicitly select the list inside it that receives tickets; ClickUp tasks belong to lists, not directly to folders.
5. An output tag and the list's initial task status. Both are configurable; there is no hard-coded Aligned list or tag.

Setup verifies read access and the chosen list/workspace, but creates no tickets. A Sentry-only installation does not need an AI account. An existing saved ClickUp token is reused. Sentry tokens live in the mode-600 CLI state file and are included in secret-bearing scanner exports.

## Suggested routing

Create/select a dedicated **Sentry Inbox** list inside whichever engineering folder you want. Use an output tag such as **sentry** and an initial status such as **to do**. Configure a separate ClickUp worker scanner to watch that list or parent folder with the same tag/status. You can instead select **ai-handle** if that is already the worker scanner's tag. Choose these during setup rather than changing code.

Example:

- Sentry producer: project node, production, destination Sentry Inbox, tag sentry, initial status to do.
- ClickUp worker: watches the engineering folder containing Sentry Inbox, tag sentry, status to do.

The producer creates the ticket on a scan. The ClickUp worker claims it on a later matching scan, using the existing multi-worker claim protocol.

## CLI configuration

Configure the ClickUp key through setup first. Set SENTRY_AUTH_TOKEN in the launching shell without writing its value into shell history. Replace the sample repository path, project, workspace, list, tag, and status below with your actual settings:

```bash
consort-cli scanners add --name "Sentry intake" --source sentry \
  --repo /path/to/shared/repository --base main \
  --sentry-org your-org --sentry-project node \
  --environment production --query is:unresolved \
  --workspace 123456 --list 234567 --tag sentry \
  --create-status "to do" --every 15
```

Multiple projects/environments can be comma-separated. For folder routing, setup is preferable because it lists and validates child lists; CLI configuration can pass both the selected list and its `--folder` ID.

`consort-cli scanners scan <id>` is a read-only preview: issue/group counts, already-ticketed groups, and how many tickets would be created. `consort-cli run -d` runs the producer on schedule. The dashboard scanner row and eight-line status log show Sentry scan results separately from worker tasks. No ticket is created until the producer actually runs.

## Grouping

Sentry already groups events into issues. Consort groups duplicate issues conservatively by organization/host, project, error title, and code location. UUIDs and hex memory addresses in titles are normalized. Different projects, errors, or code locations stay separate; missing code locations do not justify merging issues. This is deterministic grouping, not an AI guess about a shared root cause.

Each new ticket contains its group marker, every related issue ID/link, event counts, first/last-seen timestamps, environments, locations, and investigation instructions. The agent must still confirm the root cause before implementing a fix. Raw event payloads and credentials are not copied into tickets.

## Duplicate protection

Before creation, the producer enumerates accessible ClickUp tasks across the chosen workspace, including closed tasks and subtasks, without restricting tags, lists, or scanner ownership. It matches a durable group marker, Sentry issue URLs, or issue short IDs. Existing tickets from other scanners/agents are therefore respected when they contain those references. Closed matching tickets are not duplicated or reopened automatically.

For simultaneous cooperating producers, the winner atomically creates a deterministic GitHub reference under `refs/heads/consort-sentry/<hash>`. The hash includes workspace and Sentry group identity, not scanner name, output list, or tag. The producer rechecks ClickUp after winning, then creates one ticket. These reservation branches point at the configured base commit and contain no token or issue payload. The GitHub credential needs permission to create references.

A failed search never falls back to creating blindly. An ambiguous creation timeout, missing task ID, or existing reservation without a visible ticket blocks another creation. The status log reports reserved groups for reconciliation. This favors avoiding duplicates over automatic retries after ambiguous writes.

All cooperating producers must use the same reservation repository. ClickUp visibility limits apply: an inaccessible task cannot be detected. An unrelated agent that creates a ticket concurrently without this protocol can still race the producer; ClickUp's task-create API does not provide an atomic workspace-wide uniqueness constraint. Existing tickets without a group marker or Sentry reference cannot be reliably matched by meaning alone.

### Reconcile an orphan reservation

If a reservation exists without a ticket, first inspect the full workspace and stop other producers for that group. The previous request may have created a task despite its timeout. If you find the task, keep the reservation and its Sentry references. Only after confirming no task exists should an operator remove that exact reservation reference and rerun the scan. Consort never automatically removes reservations or deletes tickets. GitHub branch rules must allow this namespace; normal cleanup tooling must leave these references alone.

## Existing Aligned logic reviewed

The implementation follows the existing `SentryClient` shape in `aligned-mono/packages/core/src/services/clients/sentry.client.ts` and its `sentry-daily.cron.ts` production/development digest. Those components read unresolved issues and post Slack digests; they do not create or deduplicate ClickUp tickets. The new scanner adds routing and ticket production in Consort without changing that service or cron.

The new scanner uses the supported [Sentry organization issues API](https://docs.sentry.io/api/events/list-an-organizations-issues/), [ClickUp workspace task search](https://developer.clickup.com/reference/getfilteredteamtasks), [ClickUp task creation](https://developer.clickup.com/reference/createtask), and [GitHub reference creation](https://docs.github.com/en/rest/git/refs#create-a-reference).
