# Consort CLI: cost and speed opportunities

Reviewed October 21, 2026. The sections below preserve the original investigation. Implementation now uses role-based models, one Fable and one Astra review (one round with one provider), separate capacity limits, and bounded parallel research/implementation. See [CLI.md](CLI.md) for current behavior. Live task savings have not been benchmarked.

## Implementation and validation

- Planning, implementation and evidence coordination use Sonnet/Sol; readers use Haiku/Luna; frontier reasoning escalates with a recorded reason.
- Reviews run once on Fable and once on Astra with both providers, otherwise once. Review questions and credit waits retain the selected provider.
- AI turns, open tasks and environments have separate scanner, account and installation limits. State updates and port reservations are atomic across workers.
- Research uses bounded readers, content-based report reuse and read-only permissions. Independent tickets use isolated worktrees, ports, Docker names and recoverable integration checkpoints.
- Slack title formatting consumes no model turn. Export/import preserves role and capacity settings.
- Final repository suite: 693 tests passed, zero failures or skips. TypeScript, CLI bundle build, whitespace check and the CLI configuration smoke check passed.
- Tests include actual temporary Git worktrees, concurrent state-writing processes, unique port allocation, SDK configuration/cancellation, provider fallback, review questions and child session ownership. Model responses and Docker are mocked; no live task or provider billing benchmark was run.
- The local CLI bundle was rebuilt. No daemon restart, live account change, commit or push was performed.

The investigation below describes behavior before implementation and its original recommendations. The requested fixed Fable/Astra policy supersedes the proposed risk-based review policy below.

## Original recommendation

Use Sol or Sonnet for ordinary planning and implementation, reserve Astra/Fable for difficult decisions, make repeat reviews depend on risk and findings, and separate active AI capacity from tasks waiting for people. Add bounded parallel research before parallel code editing.

Significant savings look plausible, but this investigation did not benchmark completed tasks. No measured end-to-end savings or energy reduction is claimed.

## Behavior before implementation

| Area | Current behavior | Source |
| --- | --- | --- |
| Planning | Strongest seeded model handles grilling and stages outside Implementing, Ready to Test, Revising | `src/cli/pipeline.ts:55–64`, stage loop |
| Execution | Next ranked model handles environment, implementation, review fixes, evidence collection, CI repair | `src/cli/pipeline.ts` |
| Model catalog | CLI uses static `MODELS` through `seedModels()`, rather than live model discovery | `src/shared/headless.ts:147`, `src/shared/types.ts:13–14` |
| Reviews | Always three rounds; both providers available means Astra, Fable, Opus; each round can trigger fixes | `src/shared/headless.ts:133–145`, `src/cli/pipeline.ts` review loop |
| Parallel tasks | Default limit is two; working, waiting, and monitoring tasks all occupy slots | `src/cli/index.ts:171`, `src/cli/index.ts:372–373` |
| Parallel implementation | Prompt keeps one main ticket in flight and allows delegates under limited conditions | `src/shared/shipPrompt.ts:161` |
| Review delegates | Existing review skill already assigns file groups to lower-tier agents | `skills/pr-writeup/SKILL.md`, model tiers and Phase 2 |
| Cost accounting | Task totals retain tokens, dollars, turn count, and unknown models; no stage-level breakdown | `src/shared/headless.ts:487–521`, `src/cli/state.ts` |

## Original proposed changes

### 1. Select models by job, not strongest available

- Default routine research, specs, implementation, and review coordination to an explicitly configured Sol or Sonnet model.
- Use Luna or Haiku for bounded extraction and formatting; Slack title generation can also be a plain function instead of an agent turn. It currently uses the worker tier in `src/cli/slackIdentity.ts:13`.
- Keep Astra/Fable for uncertain cross-system behavior, security-sensitive decisions, business-flow conflicts, or a cheaper model failing a defined task.
- Preserve the business-impact question and owner decision before breaking a viable flow.
- Limit retries before escalation, and record the reason; otherwise a cheaper first attempt can cost more after rework.

Fix model ordering before expanding the catalog: `rankModel()` ranks Codex by version, so GPT-6.1 Sol would rank above GPT-6 Astra. Its delegate selection also cannot distinguish equally versioned Codex families. Explicit role mappings should survive provider fallback rather than inferring the role from the current model string.

### 2. Replace three mandatory review rounds

- Run one independent review for routine changes, followed by fixes and checks.
- Re-review changed code and affected callers after fixes, rather than automatically repeating full scope.
- Add a second provider or frontier review for migrations, permissions, shared business rules, unclear findings, or substantial repairs.
- Preserve independent evidence inspection, acceptance checks, and required GitHub approvals.

One review instead of three removes two of three review orchestrator turns and their delegated reading for eligible tasks. That is a reduction in review work, not a claim of 67% lower total task cost. Parallel full reviews could shorten elapsed time but would still duplicate reading and would examine the same pre-fix revision.

### 3. Separate active work from waiting tasks

- Keep separate limits for active agent turns, open tasks, and running environments.
- Allow another task to start when a task waits for Slack or GitHub review.
- Acquire an active-turn slot again when an owner reply or review comment resumes work.
- Bound concurrency by account allowance and machine capacity.

Today two monitoring PRs can occupy both default slots. This affects queue throughput, not the duration of either PR's implementation. Before raising concurrency, address whole-file state updates in `src/cli/state.ts`: atomic rename protects the file from partial writes but does not merge simultaneous updates from workers.

### 4. Parallelize bounded research, then independent implementation

- Run callers/business-flow tracing, test discovery, and integration/schema research concurrently when their scopes differ.
- Give each reader specific files and a short report path; one coordinator combines findings and asks owner questions.
- Reuse a task research summary keyed to relevant file revisions so specs, implementation, and reviews can reuse discovered facts while checking changed code.
- Later allow two independent ready implementation tickets, including tickets within one package when they do not share files or depend on each other.
- Use separate worktrees for writers and one coordinator for integration, commits, and final tests.

Parallel reading reduces elapsed time only when the reading is independent; it does not inherently reduce tokens. Shared context and eliminating repeated reads provide the cost benefit. Avoid concurrent writers sharing the current branch, index, review report paths, or mutable task session.

## Pricing and measurement

OpenAI's current standard short-context API table lists GPT-6 Astra at $10 input / $50 output per million tokens and GPT-6.1 Sol at $2 / $10. For equal uncached input and output tokens, Sol is 80% cheaper. If half of a task's bill moved from Astra to Sol without increasing tokens or retries, the illustrative total reduction would be 40%. These API comparisons do not establish subscription quota savings or task speed. Availability must be checked for each configured account. [Official pricing](https://developers.openai.com/api/docs/pricing).

OpenAI recommends comparing models on the same inputs and keeping the lightest setting that meets the quality bar. Sol targets complex work where cost matters; Luna targets scoped work. [Official model-selection guidance](https://developers.openai.com/api/docs/guides/model-selection).

Before measuring a rollout:

- Record stage, model, provider, duration, input/output/cache tokens, retries, findings, and escalation reason per turn.
- Include consumed usage from attempts that hit limits: the current `pipeline.ts` limit branch continues before adding returned usage.
- Add verified current prices: Astra has no `PRICES` entry; GPT-5.6 Sol currently falls through to generic GPT-5 pricing in `priceFor()`.
- Compare the existing policy and proposed policy on the same representative tasks using final acceptance checks, review defects, cost per completed task, and active work time.
- Report owner/GitHub waiting time separately from AI execution time.
- Use tokens and retries as usage measures; this repository has no measurement of provider energy consumption.

## Original suggested implementation order

1. Add per-turn measurements, correct price lookup, and explicit configurable model roles.
2. Introduce ordinary-model defaults with bounded escalation and compare against the current policy.
3. Make repeat reviews depend on risk and changed code.
4. Make state updates safe across workers, then separate waiting tasks from active-turn capacity.
5. Add bounded parallel research, then independent implementation worktrees.

This order establishes whether cheaper models preserve quality before increasing simultaneous model usage.
