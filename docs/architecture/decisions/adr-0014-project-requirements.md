---
type: "Decision"
title: "Project requirements"
description: "Requirements belong to a Project, developers report Progress while QA verifies once per Project, and the merge-to-main gate is per Project. Supersedes the per-repository parts of ADR-0013."
tags: [architecture, decision, projects, qa, requirements]
status: stable
timestamp: "2026-10-01T00:00:00Z"
sources:
  - id: qa-runs
    resource: "/architecture/decisions/adr-0013-qa-verification-runs.md"
    title: "QA verification runs"
  - id: provider-boundaries
    resource: "/architecture/decisions/adr-0004-provider-and-port-boundaries.md"
    title: "Provider and port boundaries"
  - id: design
    resource: "/design/project-requirements.md"
    title: "Project requirements design"
---
# ADR-0014: Project requirements

**Decision date:** 2026-10-01
**Decision status:** Accepted
**Supersedes:** the checklist-sharing, per-repository run, per-repository gate and persona-per-item parts of [ADR-0013](adr-0013-qa-verification-runs.md). Its commit-keyed snapshots, server-resolved commits, run-row locking, frozen sign-off report and automated-results rules still stand and are reused unchanged.
**Scope:** Project-owned requirements, the Progress and Verification tracks, Project-scope runs, and the per-Project merge-to-main gate

Terminology: a "Project" is a hierarchy delivery project (the folder that owns repositories); a "repository" is a `projects.provisioned_projects` row.

## Decision

1. **A Project owns its requirements.** They are `projects.qa_checklists` rows with a `delivery_project_id` (a plain UUID, no foreign key: another context owns the Project) and a `kind`: `functional` is a Feature whose items are User stories, `system` is a flat checklist. Every existing checklist becomes a `system` requirement. Product owners (`lead`) and admins create and edit them; nobody else does. Requirements apply to every repository of the Project; the per-repository share table is legacy and no longer read for requirements that have a Project.
2. **Two independent tracks per item.** *Progress* (`todo`, `in_progress`, `done`) lives on the requirement item, set by developers, leads and admins; `done` means ready for QA. *Verification* (`pending`, `passed`, `failed`, `blocked`, `returned_to_dev`) lives on the run item, set by QA, leads and admins. QA never writes Progress and developers never write Verification. Progress is on the definition because it persists across runs; Verification is on the run item because it is a verdict about specific commits.
3. **The tracks meet in three places.** `passed` is refused (409 `QA_PROGRESS_NOT_DONE`) unless the source item's Progress is `done`, checked inside the item write under a `FOR SHARE` lock. `returned_to_dev` sets the source item back to `in_progress` in the same transaction. A developer setting Progress to `done` re-queues any `returned_to_dev` run item to `pending` and notifies QA. Lock order is run row, then run item, then requirement item; a Progress write only takes the requirement item.
4. **QA verifies once per Project.** A Project run captures the `uat` head of every repository when it starts (`qa_run_repositories`) and snapshots every active requirement's items. The key is a sha256 of the sorted `<repository>:<head>` lines, unique per Project, so creating a run for heads that already have one returns it. The server reads the heads; the client never sends a SHA. Repository-scope runs are read-only history; every write on them answers 409 `QA_RUN_LEGACY_READONLY`.
5. **The merge-to-main gate is per Project.** A repository may merge `uat` to `main` only when the latest signed-off Project run (greatest active `signed_at`; open runs never count) is `APPROVED`, the Project has requirements, every head was readable, and the run is current: it covers every repository and each captured head equals the head now. Any repository moving, or joining the Project, makes it stale for all of them. A repository filed under no Project is blocked (409 `QA_PROJECT_REQUIRED`). Requirement edits after a sign-off are informational (`requirementsChanged`) and never change the gate; a lead may reopen.
6. **The schema change is additive and applied before the backend.** The new code reads columns the old code does not know, so the migration goes first; it is idempotent and is re-run once after the deploy to catch checklists shared in between. The old per-workspace name index is replaced by one scoped to (workspace, Project, kind), and the earlier migration that created it is guarded so replaying the tree cannot recreate it. A checklist shared to repositories in two Projects becomes one requirement per Project (the original keeps its id so old runs stay linked).
7. **Cross-context access goes through ports.** `ProjectLinkPort` gains `getDeliveryProject` and `listDeliveryProjectsForGroup`; the frontend-repository rule for notifications reads the runtime-owned `DEPLOYMENT_TARGETS_QUERY`; deleting a Project removes its requirements through the new `DELIVERY_PROJECT_DATA_CLEANUP` port. The only inline `hierarchy.*` SQL is the one-time backfill, recorded as two exact pairs in the schema-ownership gate.

## Consequences

- Persona rules are allow-lists in `qa-run-access.rules.ts`; `personaAllowsRole` and per-item `targetPersona` no longer gate anything.
- The old routes are kept for one release as deprecated: legacy checklist writes on a Project-owned row answer 409 `REQUIREMENT_MOVED_TO_PROJECT` (the item replace would delete Progress), and the per-repository feeds are derived from the repository's Project.
- A Project run notifies through the Project's frontend repository, else its oldest linked repository.
- Strict staleness is intended: the QA'd combination changed, so the sign-off no longer describes what would ship.
