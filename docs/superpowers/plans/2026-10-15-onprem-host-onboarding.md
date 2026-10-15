# On-prem host onboarding delivery order

The design was approved on 2026-10-15 and executed sequentially. Project repairs, enrollment, assignment APIs, installers, and UI are implemented locally. The three targeted migrations are applied to the remote test database. Enterprise runs with normal sign-in and the temporary HTTPS tunnel. Workflow publication, actual host enrollment, Windows restart/startup, and the user's eatta promotion acceptance remain open. See [execution evidence](../../operations/onprem-local-acceptance.md).

Read the [approved design](../specs/2026-10-15-onprem-host-onboarding-design.md), then execute these plans in order:

1. [Repair existing project deployment](2026-10-15-onprem-project-repairs.md). Fix history, add factual readiness checks, and make `eatta` CI reach this laptop through the selected temporary HTTPS tunnel. This stage can ship independently.
2. [Enroll hosts](2026-10-15-onprem-host-enrollment.md). Add workspace inventory, protected one-use enrollment, heartbeat, installers, and Hosts UI. Existing environment-token agents remain supported.
3. [Assign multiple projects](2026-10-15-onprem-host-assignments.md). Add environment bindings, isolated deployment workers, host selection, and two-project acceptance tests.

Each plan has its own test cycle and acceptance evidence. Stage 1 does not establish that a host deployed an application. Stage 2 does not establish that several projects run safely together. Stage 3 requires real Docker deployment and recovery evidence.

Use separate backend/frontend feature branches and commits. Preserve the frontend's existing local changes. Do not publish or merge product PRs automatically. Workflow update previews are local review artifacts until publication is authorized. The temporary tunnel and targeted operator setup belong to the agreed test, with their actual results recorded separately from source changes.

Recommended execution method: Native. The enrollment, binding authorization, supervisor, and UI share contracts that benefit from sequential implementation in this session. Use one independent whole-branch review after implementation, before publication.

For each database E2E step, provision disposable local PostgreSQL and set `E2E_ADMIN_DATABASE_URL` to that instance. In the test shell set `ALPHACI_IGNORE_ENV_FILE=true`, remove remote `SUPABASE_DB_URL`/`DATABASE_URL` values, and run `node scripts/run-edition.mjs enterprise npx jest --config tests/e2e/jest-e2e.json --runInBand --testPathPattern='<named-test-file>'`. Replace the pattern with the exact test named by the task. An unset local admin URL is a setup failure; never substitute shared Supabase. Existing fixtures create and drop dedicated test databases. Run unit tests with `--runInBand`; run the full backend gate with `npm run lint`, `npm run typecheck`, `npm test -- --runInBand`, and `npm run check:documentation`. Inspect each result before continuing.

Self-review completed against the approved design: all requirements map to the three plans, shared contract names match, failure cases have assigned tests, and rollout preserves legacy agents. Windows reboot recovery and two-project Docker acceptance remain required runtime checks, not claims made by this document.
