# AGENTS.md — alphaci-golden-copy-be

NestJS 11 modular monolith backend for the AlphaCI Golden Copy. The frontend is
the sibling `alphaci-golden-copy-fe` repository.

## Start here

- [docs/constitution.md](docs/constitution.md): bounded contexts, product axes,
  events, schema ownership. Read it before changing structure.
- [docs/architecture/decisions/](docs/architecture/decisions/): ADRs. Add one
  only for a decision that is hard to reverse.
- [docs/runbooks/](docs/runbooks/): migrations, outbox, provisioning, local
  verification.
- [docs/superpowers/plans/](docs/superpowers/plans/): active plans only.

## Verify

- `npm run check` runs every static gate once (documentation, generated maps,
  boundaries, schema ownership, capabilities, migration replay).
- `npm run verify` runs typecheck, lint, `check`, the Jest suite, and the
  build-profile conformance compile. CI runs the same command.
- While iterating, run only the tests and gates for the area you touched.
- Database tests run only against the disposable loopback fixture. Never point
  a test, migration, or backfill at a hosted or customer database.

## Testing

- Prefer end-to-end tests that drive the real HTTP API against a disposable
  PostgreSQL database, and use them to prove complex features work. Each E2E run
  must leave a verifiable, repeatable artifact: a report tied to the commit that
  anyone can regenerate with one command. The harness is not built yet; see
  [the deferred E2E plan](docs/superpowers/plans/2026-09-25-e2e-harness-and-test-pruning.md).
- Never write unit tests after the code to raise coverage.
- If you must test a unit in isolation, first write down the ways it can fail,
  then write the code, then one test per failure mode. Isolation is for failure
  modes E2E cannot reach cheaply: migration-ledger races, SQL envelope parsing,
  tenant predicates, configuration parsing.
- Tautological tests are harmful. Feeding a mock a value and asserting the same
  value back proves nothing.
- Change-detector tests are harmful. Do not assert SQL text, call order, mock
  call arguments, private helpers, or snapshots that a harmless refactor would
  break. Assert behavior: returned rows, HTTP responses, rejected cross-tenant
  access.
- For a bug fix, repair or extend the behavior test that should have caught the
  bug. Add a separate regression test only when no behavior test covers that
  path.
- Delete an existing test only after a behavior test covers the same failure.
  Tenant-isolation tests stay until a real-database test replaces them.

## Commits and pull requests

- The pull request is the unit of review and history. Size it as one
  reviewable feature slice or fix that can ship and roll back on its own, and
  keep unrelated cleanup in a separate pull request.
- Commit freely on the branch; that history is disposable. Squash-merge so
  `main` gets one commit per pull request that builds, passes, and carries its
  own migrations, tests, regenerated files, and docs.
- Evidence is not a commit. Put commands, results, and environment in the pull
  request description.
- Use a Conventional Commit title, for example `fix(runtime): ...`.
- Branch from `main` and merge back within days. Avoid long-lived integration
  branches.
- Do not push, open, or merge a pull request unless asked.

## Plans and documentation

- A plan is a short task list: goal, tasks, done criteria. Tick a task when it
  is done and link its evidence in one line. Delete the plan when its last task
  lands; git keeps it.
- Canonical docs under `docs/` describe the current state. Record contract and
  user-visible changes in `CHANGELOG.md`; git history covers the rest.
- `*.generated.md` files come from scripts. Regenerate them in the same commit
  as the change that affects them; never edit them by hand.
- Do not add a new script, gate, or required document without removing or
  merging an existing one, unless it protects against a real failure.
