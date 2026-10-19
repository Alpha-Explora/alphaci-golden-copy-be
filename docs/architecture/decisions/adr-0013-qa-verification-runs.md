---
type: "Decision"
title: "QA verification runs"
description: "Record manual QA against one exact commit of a hosted branch, keep the result auditable after sign-off, and show automated test results beside it without letting them decide."
tags: [architecture, decision, projects, qa, identity, pipelines]
status: stable
timestamp: "2026-09-25T00:00:00Z"
sources:
  - id: six-contexts
    resource: "/architecture/decisions/adr-0001-six-context-modular-monolith.md"
    title: "Six-context modular monolith"
  - id: provider-boundaries
    resource: "/architecture/decisions/adr-0004-provider-and-port-boundaries.md"
    title: "Provider and port boundaries"
  - id: outbox-delivery
    resource: "/architecture/decisions/adr-0005-postgresql-outbox-delivery.md"
    title: "PostgreSQL outbox delivery"
---
# ADR-0013: QA verification runs

**Decision date:** 2026-09-25
**Decision status:** Accepted
**Superseded in part by:** [ADR-0014](adr-0014-project-requirements.md): checklist sharing, per-repository runs, the per-repository gate and per-item persona rights. Repository-scope runs are read-only history; the sign-off and notification rules of Project runs are in ADR-0014 and its amendments.
**Scope:** The QA Team persona, shared checklists, verification runs, sign-off, report export, and automated results on runs

## Decision

1. **A QA Team persona is a global `app_role` value, `qa`.** It is derived from the GitHub org team named by `GITHUB_TEAM_QA_SLUG` (default `qa-team`) with precedence `team-lead` > `qa-team` > `developers`, exactly like `lead` and `member`. An unreadable team read changes nothing. `qa` carries no creator or manager power.
2. **Role checks are allow-lists.** Group creation and the effective group role test `app_role IN ('admin', 'lead')`. A check written as "not `member`" would hand any new role manager power.
3. **Checklists belong to a workspace and are shared to its projects.** Team leads and admins edit; workspace members read. Sharing is inserted through a SELECT that matches the checklist's workspace, so a checklist cannot be shared across workspaces. Deleting a workspace deletes its checklists through the `WORKSPACE_DATA_CLEANUP` port, because the tables may not hold a foreign key into another context.
4. **A verification run is keyed on (project, checklist, branch, commit).** The server resolves the commit under test: the newest ready deployment of the branch, otherwise the branch head. The client never sends a commit. A promoted commit exists on several branches, so nothing is keyed on the commit alone.
5. **A run snapshots its checklist items.** Editing or deleting the checklist later never changes a run. The run keeps the checklist name and version; its link to the checklist becomes null if the checklist is deleted.
6. **Item rights follow the item's target persona.** Developer items: Developer, Team lead, Admin. QA items: QA Team, Team lead, Admin. Items for everyone: all four. Only QA Team, Team lead and Admin may return an item to a developer. Failed and returned items require a severity.
7. **Sign-off is a server-enforced verdict.** Approved requires every item passed; Conditional requires no pending or in-progress item and written conditions; Rejected needs no item passed. No verdict is allowed while a defect is open ([ADR-0014](adr-0014-project-requirements.md) amendment 14). A signed-off run is read-only until a Team lead or Admin reopens it.
8. **Concurrent writes serialize on the run row.** Item writes take `FOR SHARE` on the run and sign-off takes `FOR UPDATE`, then re-checks the items' row-version fingerprint. Without this, an edit could land on a signed-off run, or an Approved sign-off could freeze a report that no longer matched its items. Every item write is also guarded by its own `row_version`. The conflicts a reload resolves carry `code: QA_ITEM_STALE` or `QA_RUN_CHANGED`.
9. **Sign-off freezes the report.** The signed-off run is stored as `report_json`. The report export (`qa-report/v1`, JSON, Markdown or Excel `xlsx`) returns that frozen copy exactly for a signed-off run and builds an open run live. The PDF is a browser print of the same JSON.
10. **Automated results are shown, never decisive.** A run reads the newest `quality` and `verify` CI reports for its exact branch and commit through the `CI_STAGE_RESULTS_LOOKUP` port. A Playwright item matches a failure by spec file; a truncated failure list yields `unknown`, never a guessed pass. A Playwright item with no test identifier is `unlinked` (the stage verdict stays beside it as context), never the stage's pass or fail. Automated results never change an item's recorded status. "Run Playwright" dispatches the verify workflow with the signed-in user's own GitHub token.
11. **Notifications go to the in-app inbox through the outbox.** Returned to dev, blocker, re-test requested and signed off are recorded with `NotificationEventPublisher`, injected by an explicit token.

## Context

Teams tested hosted deployments against lists kept outside the product, with no record of which build a verdict applied to and no way to hand a defect back to the developer inside AlphaCI. QA results had to become auditable: tied to one commit, unchangeable after sign-off, and exportable for a pull request or a compliance record.

## Rejected alternatives

* **Keying runs on the commit alone.** A promoted commit has a run history on every branch it reaches; a commit-only key reads another branch's verdict.
* **Letting the client name the commit.** A stale page would record a verdict against a build nobody tested.
* **Reading checklist items live from the run.** An edit after testing would rewrite a signed-off result.
* **Auto-passing items from automated results.** A green suite does not prove the acceptance criterion a person wrote; sign-off stays a human verdict.
* **A foreign key from checklists to workspaces.** The projects context may not reference another context's tables; the cleanup port keeps ownership intact.
* **Generating the PDF on the server.** It would add a rendering dependency and a second template that could drift from the Markdown; a print page renders the same JSON.

## Consequences

* A capability that declares an API field must also appear in `GET /capabilities`. The frontend derives every view flag from that response; a registered capability without the field hides its screens.
* Optional dependencies typed with a type alias need an explicit `@Inject` token. TypeScript emits the alias as `Object`, Nest finds no provider, and `@Optional()` injects `undefined` silently.
* Deploying code that writes a new column requires its migration first. `superseded_by_login` and the nullable run checklist link were applied before their code shipped.
* The automated badge depends on the central Playwright workflow publishing per-test outputs, and on each project enabling Playwright's JSON reporter. Without them, items show stage-level results.

## Verification

* `npm test` covers the persona role resolution, the allow-list group checks, every run rule (commit resolution, persona rights, severity, sign-off, reopen, locking and the fingerprint abort, fix-request reset), the report mapper and Markdown, and the automated-result matcher.
* `tests/architecture/http-boot.spec.ts` boots the application and asserts the QA services receive the real audit and notification publishers.
* `capabilities.controller.spec.ts` asserts every catalog capability with an API field appears in the capabilities response.
