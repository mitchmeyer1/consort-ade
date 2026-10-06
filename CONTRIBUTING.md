# Contributing

Consort is an Electron app (main process in `src/main`, React renderer in `src/renderer`, shared pure modules in `src/shared`). Most behaviour lives in `src/shared` as plain functions so it can be tested without Electron.

## Run it

```bash
pnpm install
pnpm dev            # electron-vite dev server with hot reload
pnpm install:mac    # build, package and install /Applications/Consort.app (macOS, arm64)
```

## Test it

```bash
npx tsc --noEmit -p tsconfig.json
node --test 'tests/*.test.mjs'
```

Tests are plain `node:test` files that import TypeScript directly (Node 22.12+). Main-process modules are tested by transpiling them with `typescript` and injecting their `electron` and child-process dependencies, so new main code should take its outside world as an injectable `deps` object the way `src/main/cliRuntime.ts` and `src/main/modelDiscovery.ts` do.

## Conventions

- Comments explain why, not what. Every shared module opens with a short block saying what it is for and where it is used.
- Prompts the agents receive live in `src/shared` next to the code that reads their output, so a change to a marker changes both sides.
- Nothing Consort writes into a user's repository goes under version control: everything lands in `.consort/`, which Consort adds to the repo's `info/exclude`.
- User-facing copy says what Consort does and who acts next. Avoid internal names.

## Pull requests

Open a PR against `main`. CI runs the typecheck and the test suite. Describe the flow you changed and attach a screenshot when the UI moved.
