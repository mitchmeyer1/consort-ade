# Review categories — agent brief

Paste this whole file into every fan-out agent. It mirrors the nine labels the CI reviewer
(`scripts/ci/pr-review.ts`) uses, so a writeup and a bot review speak the same language.

Every finding has a **severity** (defects) *or* a **category** (everything else), never both
buckets at once. A category item that has a nameable failure scenario is a defect — give it a
severity and tag the category as its origin.

## Severities — defects (🟥 CRITICAL · 🟧 HIGH · 🟨 MEDIUM · 🟦 LOW)

- **🟥 CRITICAL** — bugs that move money wrongly or land data on the wrong person, security holes
  (authz/IDOR, secrets, PHI in logs, injection), data loss, race conditions.
- **🟧 HIGH** — logic errors, unhandled edge cases, missing validation at a trust boundary,
  breaking changes, stuck states, a security control that does not hold. **Performance**: a
  Drizzle/SQL query inside a loop or per-element `.map()`/`for…of` where one `inArray(...)`,
  batch, or join would do; loading a table then filtering in JS; a query on a growing table with
  no `WHERE` and no `.limit()`; sequential `await`s that could be one statement or `Promise.all`;
  `COUNT(*)`/full scans on hot paths; unbounded loops over user input.
- **🟨 MEDIUM** — visible failure with bounded blast radius; code quality that will bite (poor
  naming that misleads, error messages leaking internals). Not redundancy, style, or coverage —
  those have categories.
- **🟦 LOW** — readability or documentation gaps a linter does not catch.

Severity is consequence. It never promotes a non-defect.

## Categories — non-defects (⛓️ LOGIC · 👯 REDUNDANT · 💅 STYLE · 🧪 TESTS · 📜 COMMENTS)

### ⛓️ LOGIC
Trace every function added or modified. Read callees in other files when needed; never assume a
call is safe because it compiles. Flag:
- **Unused** bindings, destructured fields, or parameters.
- **THIN** — controllers, webhooks, workers, crons must read like a book. New logic belongs in a
  service; table-shaped logic in the `*.model.ts`.
- **Empty or silent branches** — empty `else`, `catch` that only comments, `default:` doing nothing.
- **Silent failures** — a DB write or vendor call whose error is caught and dropped; a worker or
  cron that swallows and exits clean.
- **Missing comms** — a significant state change or failure with no Slack / Customer.io / Twilio
  notification when peer code in the same service clearly notifies.
- **Logic gaps** — an enum only partly handled; a case the author clearly meant to handle.
- **Misleading control flow** — a buried early return, a loop that runs once, an `async` that
  never awaits.
Shape: `file:line | gap | fix`.

### 👯 REDUNDANT
Only the PR's new code. Flag a new function/class/service that duplicates an existing one
(renamed copies and subtle rewrites count), or the same logic repeated across the diff that one
helper would cover. **Name the specific other definition** (`file:line`) or drop it.
Shape: `new file:line ↔ existing file:line | overlap | drop / merge / reuse`.

### 💅 STYLE
Keep *this* codebase internally consistent; house pattern beats "proper convention". Flag new
code whose file naming, location, module shape, imports, naming, error handling, logging, env
access, async style, or test patterns diverge from **3+ agreeing peer files**. If peers disagree,
the convention is not set — do not flag. Repo-specific: `process.env` only in services, never
models/controllers; Postgres only through `packages/core/src/db/client.ts` (tests:
`scripts/setup-test-db.ts`), same idea for Mongo — no new access points; surfaces read top-down.
Never flag what the linter/formatter handles. Judge conventions against `CLAUDE.md`, not taste.
Shape: `file:line | deviation | peer file that shows the house way | fix`.

### 🧪 TESTS
For each meaningful chunk of new logic: is it tested? **Coverage rarely sits next to the code** —
grep `tests/` and `packages/` for the symbol *and its class/service* before claiming absence; a hit
for `RetellService` covers `RetellService.placeCall`. No positive evidence of absence → no finding.
When you do flag, name the suite:
- new SST infra (queue, Lambda, cron, bucket) → **smoke**, `tests/smoke/`, `pnpm test:smoke`
- new backend logic (service, controller, cron, worker, model, util) → **standard**,
  `tests/standard/`, `pnpm test`
- new vendor integration or new method on a vendor client → **external-service**,
  `tests/external-services/`, `pnpm test:external-service` (one happy-path real call)
- new React page/component/flow → **frontend**, `tests/frontend/`, `pnpm test:frontend`
Rule of thumb: passes with nothing outside the repo healthy → standard/frontend; needs a live key →
external-service; needs AWS in a state → smoke.
Also flag: a test in the wrong suite; happy-path-only tests on logic with real error paths; mocks so
loose they mock the thing under test. Skip getters, re-exports, types, config, scaffolding.
Shape: `file:line | what is uncovered or wrong | suite + suggested test path | what it costs`.

### 📜 COMMENTS
House style: one top docblock (≤ 25 lines) + single-line `//` where the *why* is not obvious. Flag a
top docblock over ~25 lines; 4+ consecutive comment lines inside a function body or above fields;
stacked jsdoc on self-describing fields; comments that restate the code; a file dominated by
narrative. **Show the trimmed comment** in the repo's voice — one or two plain casual sentences,
no hedging asides. One line of code needs at most one comment line; a function at most two.
Do not flag a ≤ 25-line top docblock, single-line why-comments, jsdoc on exported API where the type
is not enough, or license headers.
Shape: `file:line-range | why it's too much | the trimmed version`.

## False-positive traps — do not flag

- **Mixed patterns are usually principled.** Two shapes for similar things typically track
  stateful vs stateless, per-instance vs shared. Ask if the chosen shape fits *this* thing.
- **Per-call values do not belong in constructors.** Timestamps, request inputs, user IDs are
  method parameters by design.
- **Verify a substitute before suggesting it** — confirm the barrel exports the symbol and the
  types match.
- **Do not reverse a deliberate refactor made in this same PR.**
- **No verification findings.** "Worth confirming", "harmless but noting", "no action needed" —
  that is scratch reasoning. If you argued yourself out of it, drop it.
- **Well-known crypto/auth primitives reject empty input by construction.** No "add an
  `if (!signature)` guard in case the SDK changes".
- **Absence claims need positive evidence.** "No test", "unused", "duplicates" — you see a diff
  and greps, not the repo. Point at the evidence or drop it.
- **Intentional changes are not regressions.** A changed default or relocated helper is a decision.
- **Prove the ordering claim before flagging a fail-fast throw.** "Breaks at import time" needs a
  module-scope call site; "may run before init" needs a concrete path. The guard's *condition*
  being wrong, or a telemetry caller that a throw would mask, is still fair game.
- Work the PR body calls a follow-up; missing docs; ops work; merge-process advice; guards for
  states that cannot occur; "no test" for code with no test surface.

## Return format

Only lines you actually read at the review SHA. No speculation, no "consider extracting".

```
DEFECT | file:line | severity | origin category or "-" | claim | what the code does |
  failure scenario (inputs → wrong outcome) | smallest fix | ignore-if
ITEM   | file:line | category | claim | detail per the category's Shape above
GOOD   | file:line | what is genuinely well built and why it should survive a refactor
```

Include a GOOD line per file where earned. Zero findings for a file is a normal answer.
