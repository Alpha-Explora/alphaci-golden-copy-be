# E2E harness and unit-test pruning (deferred)

**Goal:** Prove features through the real HTTP API against a disposable
PostgreSQL database, then delete unit tests whose failure modes those E2E
tests cover.

**Why deferred:** On `main` the E2E suite is one health check, so no unit test
can yet be shown redundant. Deleting first would remove the only coverage,
including tenant-isolation tests. The harness is the prerequisite.

## Tasks

- [ ] Commit an E2E harness that starts the loopback PostgreSQL fixture, creates
      a uniquely named database per run, applies migrations with the ledger
      runner, seeds two tenants, boots the real `AppModule`, and drops the
      database afterward. It must refuse any non-loopback host.
- [ ] Write `artifacts/e2e/<short-sha>/report.json` and `report.md` on every
      run (scenarios, endpoints, HTTP statuses, PostgreSQL version, migration
      plan digest) so one command, `npm run test:e2e`, regenerates it.
- [ ] Cover the main flows end to end: unauthenticated rejection, tenant
      project isolation (list, read, update, delete), capability 404 before
      Billing 402, outbox write and relay.
- [ ] Add the E2E job to CI with a disposable PostgreSQL service container,
      including the database integration scenarios now removed from the hosted
      `SUPABASE_DB_URL` CI step.
- [ ] Prune unit tests module by module (parallel agents allowed). For each
      deleted test, name the E2E or behavior test that covers the same failure
      in the pull request. First candidates: mock-call assertions in
      `projects.service.spec.ts` and the controller specs, and
      `tests/architecture/contract-snapshots.spec.ts`.
- [ ] Keep isolated tests for migration-ledger races, SQL envelope parsing,
      tenant predicates, and configuration parsing.

## Done when

- `npm run test:e2e` passes locally and in CI and leaves the report artifact.
- No CI step points a test at a hosted database.
- Every deleted unit test is traced to a covering E2E or behavior test.
- Delete this plan.
