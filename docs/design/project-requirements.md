---
type: "Design Specification"
title: "Project requirements"
description: "Design for Project-owned functional and system requirements, Iterations, two-track progress and verification, Project-level QA runs with test cases, Product owner acceptance, and the per-Project merge-to-main gate."
tags: [design, projects, qa, requirements, migrations]
status: stable
---
# Project requirements

**Status:** Implemented in the backend. The decisions are recorded in [ADR-0014](/architecture/decisions/adr-0014-project-requirements.md) and its amendments.
**Builds on:** [ADR-0013 QA verification runs](/architecture/decisions/adr-0013-qa-verification-runs.md).

Terminology. In QA code, "project" means a `projects.provisioned_projects` row, which is one repository. A "Project" in the product (API term `delivery-project`, SQL `hierarchy.delivery_projects`) is the folder that owns one or more repositories. This document writes "repository" for the first and "Project" for the second.

## Summary

1. A Project owns its requirements. There are two kinds: `functional` (a Feature whose items are User stories) and `system` (a flat checklist). Every checklist that existed before became a `system` requirement.
2. Requirements apply to every repository in the Project. The per-repository share table is legacy and is not read for requirements that have a Project.
3. A Project works in Iterations. At most one Iteration is active. Requirements and Project runs belong to one Iteration, and only the current Iteration counts.
4. Each item has two independent tracks: **Progress** (`todo`, `in_progress`, `done`) set by developers, leads and admins; **Verification** (`pending`, `passed`, `failed`) set by QA, leads and admins. `failed` returns the story to the Developers.
5. QA verifies once per Iteration and set of heads. A Project run captures the `uat` head of every repository when it starts.
6. QA writes test cases under a User story and records a result per test case in each run.
7. After QA signs a run off as `APPROVED` or `CONDITIONAL`, a Product owner accepts it item by item.
8. A repository may merge `uat` to `main` only when the latest signed-off Project run of the current Iteration is `APPROVED`, still current for every repository, passed every item of the Iteration, predates no requirement change, and every item is accepted. Merging every covered repository delivers the Iteration.

## 1. Schema and migrations

### 1.1 Model

| Concept | Table | Columns and keys |
|---|---|---|
| Iteration | `projects.project_iterations` | `number`, `goal` (max 120), `status` (`active`, `delivered`), `started_*`, `delivered_*`, `signoff_run_id`, `delivery_json`; unique (`delivery_project_id`, `number`); at most one `active` per Project |
| Requirement | `projects.qa_checklists` | `kind`, `delivery_project_id`, `iteration_id`, `legacy_checklist_id`; active names unique per (workspace, Iteration, kind, lower(name)) |
| Requirement item (story or checklist item) | `projects.qa_checklist_items` | `acceptance_criteria` (max 4000), `progress`, `progress_by`, `progress_by_login`, `progress_at`, `row_version`, `updated_at` |
| Test case category, test case | `projects.qa_test_case_categories`, `projects.qa_test_cases` | section 7 |
| Project run | `projects.qa_verification_runs` | `scope` (`repository`, `project`), `delivery_project_id`, `iteration_id`, `heads_fingerprint`; `project_id` and `commit_sha` nullable; unique (`iteration_id`, `heads_fingerprint`) for `scope = 'project'` |
| Heads captured at run start | `projects.qa_run_repositories` | `run_id`, `project_id`, `repo_full_name`, `head_sha`; key (`run_id`, `project_id`) |
| Run item snapshot | `projects.qa_run_items` | `requirement_id`, `requirement_name`, `requirement_kind`, `acceptance_criteria`, `po_status`, `po_by`, `po_by_login`, `po_at` |
| Run test case | `projects.qa_run_test_cases` | section 7 |
| Screenshot evidence | `projects.qa_run_item_attachments`, `projects.qa_attachment_objects` | up to 5 images per run item |
| Sign-off, events | `projects.qa_run_signoffs`, `projects.qa_run_item_events` | shared with repository-scope runs |
| Legacy sharing | `projects.qa_checklist_projects` | not read for requirements that have a `delivery_project_id` |

The run, item, event, sign-off, report and row-locking machinery works on `run_id` and does not care whether a run covers one repository or many. Repository-scope runs stay as history with `scope = 'repository'`. Table names keep the `qa_checklist` prefix; the API and docs say "requirement".

Progress lives on the requirement item because it persists across runs and across rebuilds of `uat`. Verification lives on the run item because it is a verdict about specific commits.

### 1.2 Ownership and RLS

- `delivery_project_id` is a plain UUID with no foreign key, like `workspace_id`: the `projects` context may only reference the `projects` and `workflow` schemas (`scripts/check-schema-ownership.cjs`).
- Runtime reads of `hierarchy.*` go through `ProjectLinkPort`: `getDeliveryProject(deliveryProjectId)` returns the group id, name and non-archived repositories with their provisioned project ids, and `listDeliveryProjectsForGroup` lists a team's Projects.
- Deleting a Project removes its requirements through the kernel port `DELIVERY_PROJECT_DATA_CLEANUP`, implemented by projects and called by `DeliveryProjectsService`. Runs stay as history because their snapshot is self-contained.
- Only the one-time backfills read `hierarchy.*` inline. They are reviewed exact-pair entries in `LEGACY_MIGRATION_REFERENCES`, not whole-file exemptions.
- Every new table enables RLS and revokes all from `anon` and `authenticated`.

### 1.3 Migrations

All live in `supabase/migrations/projects/`. Each is idempotent: every constraint is inline or guarded, so a cold replay and a re-run both succeed.

| File | Does |
|---|---|
| `20261001010000_project_requirements.sql` | adds `kind`, `delivery_project_id`, `legacy_checklist_id`, item acceptance criteria and Progress, run `scope`, `delivery_project_id`, `heads_fingerprint`, the `qa_run_repositories` table and the run item requirement columns; adds the `qa_verification_runs_scope_shape_chk` check; backfills each shared checklist into one `system` requirement per Project its repositories belong to (the original keeps its id, so old runs stay linked; other Projects get a copy with `legacy_checklist_id`) |
| `20261014010000_qa_run_item_attachments.sql`, `20261019010000_qa_attachment_objects.sql` | screenshot evidence on run items |
| `20261015010000_project_iterations.sql` | creates `project_iterations`, adds `iteration_id` to requirements and runs, backfills Iteration 1 for every Project, adds presence checks, and swaps both unique keys to per-Iteration (`uq_qa_requirements_iteration_name_active`, `uq_qa_runs_iteration_heads`) |
| `20261020010000_qa_test_cases.sql` | test case categories, test cases and run test cases |
| `20261021010000_qa_po_acceptance.sql` | `po_status`, `po_by`, `po_by_login`, `po_at` on run items |

Rollbacks are in `supabase/rollbacks/`. They fail closed when the older schema cannot hold the data: `20261001010000_project_requirements_down.sql` while any Project run or `functional` requirement exists, `20261020010000_qa_test_cases_down.sql` while any test case row exists.

### 1.4 Status values

- Item `progress`: `todo`, `in_progress`, `done`. `done` means ready for QA.
- Run item `status`: new writes set `pending`, `passed` or `failed`. Rows written earlier may hold `blocked` or `returned_to_dev`; both read as open defects, and `returned_to_dev` reads like `failed`. `in_progress` is never written on Project runs.
- Run item `po_status`: `pending` or `passed`. Any QA status write resets it to `pending`.
- Project run rows: `branch = 'uat'`, `commit_source = 'branch_head'`, `commit_sha` NULL, `checklist_id` NULL, `checklist_version` 0, `checklist_name` = the Project name at run start.
- Run item `position` is global across the run: requirements in order (functional first, then system, by creation), items by position.

## 2. API contract

Every route sits behind `@RequiresCapability('projects.qa-checklists')`. The caller must be an active member of the Project's group (`QaAccessService.canAccessWorkspace`), else 404. Errors use the shape `{ statusCode, code?, message, reasons? }`. Every write on a delivered Iteration answers `409 ITERATION_DELIVERED`.

### 2.1 Shapes

```ts
type RequirementKind = 'functional' | 'system';
type Progress = 'todo' | 'in_progress' | 'done';

interface RequirementItem {            // a "story" when kind = functional
  id: string; position: number; title: string;
  acceptanceCriteria: string | null;   // max 4000
  verificationType: 'manual'|'playwright'|'unit_test'|'bruno';
  testIdentifier: string | null;
  progress: Progress;
  progressBy: { id: string; login: string } | null;
  progressAt: string | null;
  rowVersion: number;
  canSetProgress: boolean;             // caller-specific
  testCategories: TestCaseCategory[];  // always [] on system items (section 7)
}
interface Requirement {
  id: string; kind: RequirementKind;
  deliveryProjectId: string | null;    // null = unassigned legacy
  workspaceId: string; name: string; description: string | null;
  version: number; archivedAt: string | null;
  createdBy: string; createdAt: string; updatedAt: string;
  legacyChecklistId: string | null;
  items: RequirementItem[];
  progressCounts: { todo: number; in_progress: number; done: number };
}
```

### 2.2 Requirements

Requirement routes read and write the Project's current Iteration.

| Route | Who | Body / result |
|---|---|---|
| `GET /delivery-projects/:dpId/requirements?kind=&includeArchived=` | any group member | `{ deliveryProject: {id,name,groupId}, requirements: Requirement[], permissions: { canManage, canSetProgress, canManageTestCases } }` |
| `POST /delivery-projects/:dpId/requirements` | lead, admin | `{ kind, name, description?, items?: [{title, acceptanceCriteria?, verificationType?, testIdentifier?}] }` -> 201 `Requirement` |
| `POST /delivery-projects/:dpId/requirements/batch` | lead, admin | `{ kind, requirements: [{ name, description?, items? }] }` (1 to 20), all in one transaction |
| `GET /requirements/:id` | any group member | `Requirement` |
| `PATCH /requirements/:id` | lead, admin | `{ name?, description?, expectedVersion }` -> `Requirement` (bumps `version`) |
| `POST /requirements/:id/archive` | lead, admin | `Requirement` |
| `POST /requirements/:id/items` | lead, admin | `{ title, acceptanceCriteria?, verificationType?, testIdentifier? }` -> 201 `RequirementItem`, appended |
| `PATCH /requirements/:id/items/:itemId` | lead, admin | `{ title?, acceptanceCriteria?: string\|null, verificationType?, testIdentifier?, expectedRowVersion }` -> `RequirementItem` |
| `DELETE /requirements/:id/items/:itemId` | lead, admin | 204; open run items keep their snapshot (`source_item_id` set null) |
| `PUT /requirements/:id/items/order` | lead, admin | `{ itemIds: string[] }`, exactly the current set; positions rewritten in one transaction (the unique `position` constraint is deferrable) |

Edits are by item id and never delete-and-reinsert, so Progress survives. New items (single create, batch, add item) join the Iteration's open runs as `pending`.

Errors: 400 `REQUIREMENT_KIND_INVALID`, 400 `REQUIREMENT_ORDER_MISMATCH`, 400 `REQUIREMENT_BATCH_INVALID`, 400 `REQUIREMENT_BATCH_DUPLICATE_NAME` (with the 0-based `index`), 403 `REQUIREMENT_MANAGE_FORBIDDEN`, 404 (not a member or not found), 409 `REQUIREMENT_NAME_TAKEN`, 409 `REQUIREMENT_STALE` (`expectedVersion`), 409 `REQUIREMENT_ITEM_STALE` (`expectedRowVersion`), 409 `REQUIREMENT_ARCHIVED`.

### 2.3 Progress

`PATCH /requirements/:id/items/:itemId/progress` (member, lead, admin)

```json
{ "progress": "done", "expectedRowVersion": 3, "note": "optional, max 1000" }
```

Returns `{ item: RequirementItem, readyForQaNotified: boolean }`. Any transition among the three values is allowed. The write locks the item row, checks `row_version`, updates `progress` and `progress_by*`, and bumps `row_version`. When the new value is `done`, every open run of the Iteration whose run item for this story is `failed` (or `returned_to_dev`) sets it back to `pending`, records the fix request and clears the defect severity; QA is then notified (section 4.2). Errors: 403 `PROGRESS_FORBIDDEN` (qa), 409 `REQUIREMENT_ITEM_STALE`, 409 `REQUIREMENT_ARCHIVED`.

### 2.4 Project runs

Project runs live under the Project and belong to its current Iteration. The server resolves the heads; the client never sends a SHA.

| Route | Who | Notes |
|---|---|---|
| `GET /delivery-projects/:dpId/qa-runs?limit&cursor` | group member | `{ runs: ProjectQaRunListItem[], next }`, the current Iteration's runs |
| `GET /delivery-projects/:dpId/qa-runs/current` | group member | `{ run: ProjectQaRun \| null, heads: HeadStatus[], stale: boolean }` for the current set of heads |
| `POST /delivery-projects/:dpId/qa-runs` | qa, lead, admin | no body. 201 `{ created: true, run }`, or 200 `{ created: false, run }` when the Iteration already has a run for those heads |
| `GET /delivery-projects/:dpId/qa-runs/:runId` | group member | `ProjectQaRun` |
| `PATCH .../:runId/items/:itemId` | qa, lead, admin | set Verification, below |
| `PATCH .../:runId/items/:itemId/test-cases/:testCaseId` | qa, admin | test case result (section 7) |
| `PATCH .../:runId/items/:itemId/acceptance` | lead, admin | Product owner acceptance (section 8) |
| `POST .../:runId/signoff` | qa, lead, admin | `{ verdict, summary?, conditions? }`, rules below |
| `POST .../:runId/reopen` | lead, admin | supersedes the sign-off; items the Iteration holds but the run lacks are added as `pending` |
| `GET .../:runId/report?format=json\|md\|xlsx` | group member | `qa-report/v2` (`markdown` and `excel` are accepted aliases); frozen at sign-off |
| `POST .../:runId/automation/dispatch` | qa, lead, admin | body `{ projectId? }`; dispatches the verify workflow in every covered repository (or one) with the caller's token; 202 |
| `POST .../:runId/items/:itemId/attachments`, `GET .../:runId/items/:itemId/attachments`, `GET .../:runId/attachments`, `DELETE .../:runId/attachments/:attachmentId` | add: qa, lead, admin | screenshot evidence; the uploader, a lead or an admin deletes a human attachment while the run is open |

```ts
interface HeadStatus { projectId: string; repoFullName: string;
  runSha: string | null; currentSha: string | null; moved: boolean; }
interface ProjectQaRun /* extends the repository-scope QaRun */ {
  scope: 'project'; deliveryProjectId: string; deliveryProjectName: string;
  iteration?: { id; number; status } | null;
  repositories: HeadStatus[];
  stale: boolean;               // any repository moved, or one joined the Project
  requirementsChanged: boolean; // requirements changed after the run started (open) or was signed off
  items: ProjectQaRunItem[];    // QaRunItem + sourceItemId, requirementId, requirementName,
                                // requirementKind, acceptanceCriteria, progress (live),
                                // attachmentCount, testCategories, poAcceptance
  permissions: { canSetVerification, canSignOff, canReopen, canDispatch,
                 canManageTestCases, canRecordTestCases, canAccept };
  attachments: { enabled, canAdd };
  automation; automationByRepository;
}
```

Create: read the `uat` head of each non-archived repository that has a linked provisioned project, fingerprint the sorted `<repository>:<head>` lines with sha256, insert on the per-Iteration unique key, snapshot every active requirement's items, set `prior_run_item_id` to the same source item in the newest earlier run, and copy the stories' test cases. Errors: 403 for a developer, 409 `QA_NO_REQUIREMENTS`, 409 `QA_UAT_HEAD_UNREADABLE` (`reasons` lists repositories), 409 `QA_UAT_BRANCH_MISSING`, 409 `QA_NO_REPOSITORIES`.

Set Verification body: `{ status?: 'pending'|'passed'|'failed', notes?, defectSeverity?, reproductionSteps?, expectedRowVersion }`.

- Any other status answers 400 `QA_VERIFICATION_STATUS_INVALID`; a developer gets 403 `VERIFICATION_FORBIDDEN`.
- `failed` needs a severity (`blocker`, `major`, `minor`; 400 without one). In the same transaction it sets the source item's Progress to `in_progress` and clears the previous fix request.
- `passed` needs the source item's Progress `done` (409 `QA_PROGRESS_NOT_DONE`; a run item whose source was deleted cannot pass) and every test case of the story passed (409 `QA_TEST_CASES_OPEN`). Passing clears the defect severity.
- A stale write answers 409 `QA_ITEM_STALE`. A status write resets the item's Product owner acceptance.

Sign-off rules:

- Any verdict is refused with 409 `QA_RUN_OPEN_DEFECTS` while an item is `failed`, `blocked` or `returned_to_dev`.
- `APPROVED` needs every item `passed`, no open test case (409 `QA_TEST_CASES_OPEN`), and every item the Iteration holds now (409 `QA_RUN_MISSING_ITEMS`; the missing items are added to the run as `pending`).
- `CONDITIONAL` needs no item `pending` or `in_progress`, and written `conditions` (400).
- `REJECTED` may leave items `pending`.
- Sign-off takes the run row `FOR UPDATE` and re-checks the items' row-version fingerprint; a change in between answers 409 `QA_RUN_CHANGED`.

### 2.5 My QA items (project-wide)

`GET /delivery-projects/:dpId/qa/my-items` (any group member; the UI shows it to developers and QA). No per-user filter: it lists every developer's items.

```ts
interface MyQaItems {
  returned: FeedItem[];     // current run item failed (or returned_to_dev)
  inProgress: FeedItem[];   // Progress = in_progress
  todo: FeedItem[];         // Progress = todo
  readyForQa: FeedItem[];   // Progress = done and run item pending or missing (QA's queue)
}
interface FeedItem { requirement: {id,name,kind}; item: RequirementItem;
  runId: string | null; runItem: ProjectQaRunItem | null; }
```

The run is the current Iteration's run for the current heads, else its newest open run. `bucketMyQaItem` (`domain/qa-my-items.rules.ts`) is the single rule for the buckets; a `done` item whose run item is `passed` is in none.

### 2.6 Checklists overview (team level, read-only)

`GET /workspaces/:workspaceId/qa-requirements/overview?includeArchived=` (any workspace member)

```ts
{ groups: [{ deliveryProject: {id,name}, requirements: RequirementSummary[],
             latestRun: LatestRun | null,
             counts: { readyForQa: number,
                       openDefects: { blocker, major, minor, unrated },
                       members: { developer: number, qa: number } },
             promotion: { mergedRepositories, totalRepositories, lastMergedAt: iso | null } | null,
             iteration: { number, status: 'active'|'delivered', deliveredAt: iso | null } | null,
             viewerMembership: 'developer' | 'qa' | null }],
  unassigned: RequirementSummary[],
  permissions: { canManage } }
interface RequirementSummary { id; kind; name; itemCount;
  progressCounts; verification: { pending, passed, failed, blocked, returned_to_dev } | null;
  latestRunStatus: 'open'|'signed_off'|null; archivedAt }
interface LatestRun { id; status: 'open'|'signed_off'; createdAt: iso;
  verdict: 'APPROVED'|'REJECTED'|'CONDITIONAL' | null;   // active sign-off; null while open
  signedOffAt: iso | null; signedOffBy: string | null }  // signer's GitHub login
```

Everything reads the current Iteration of each Project, in batches over all the team's Projects, so the number of database round trips does not grow with the number of Projects. Projects with no requirements are listed with an empty array.

- `latestRun` is the Iteration's newest Project run; `verification` comes from the same run.
- `counts.readyForQa` uses `bucketMyQaItem` over the non-archived requirement items and the newest run's items; with no run every done item counts. **Known gap:** my-items picks its run from the live `uat` heads; the overview makes no GitHub call and always reads the newest run. They differ only when the newest run is signed off and a head has since moved: my-items then has no run and lists every done item, the overview counts only the done items that run left undecided.
- `counts.openDefects` counts the newest run's items that are `failed`, `blocked` or `returned_to_dev`, by severity (null is `unrated`).
- `counts.members` counts ACTIVE `hierarchy.delivery_project_members` rows by `member_kind`; `viewerMembership` is the caller's own active row (null for leads, admins and non-members). Both come through the `DELIVERY_PROJECT_OVERVIEW_QUERY` port.
- `promotion` is null unless `latestRun.status` is `signed_off`. It is read from the Iteration's stored delivery state (`delivery_json`): `mergedRepositories` is the repositories recorded as delivered (merged, or already in `main`), `totalRepositories` the Project's repositories linked to an AlphaCI project, `lastMergedAt` the newest delivery.
- `iteration` is the Project's current Iteration; a delivered one means nothing is waiting for production.

### 2.7 Iterations

| Route | Who | Notes |
|---|---|---|
| `GET /delivery-projects/:dpId/iterations` | group member | `{ iterations }`, newest first |
| `GET /delivery-projects/:dpId/iterations/current` | group member | the active Iteration, else the last delivered one: `{ iteration, canStartNext, deliveredRepositories, coveredRepositories, canMergeAll }` |
| `POST /delivery-projects/:dpId/iterations` | lead, admin | `{ goal? }` (at most 120 characters, 400 `ITERATION_GOAL_INVALID`) -> `{ iteration }` |

Iteration 1 is created on first use. Starting the next Iteration needs the current one delivered (409 `ITERATION_ACTIVE`, also on a lost race); it starts with no requirements. A non-empty `carryOver.requirementItemIds` answers 400 `ITERATION_CARRY_INVALID`. Others get 403 `ITERATION_START_FORBIDDEN`. Starting records `qa.iteration.started` and notifies the workspace leads, Developers and QA.

## 3. Merge-to-main gate

### 3.1 Rule

`evaluateProjectPromotionGate` in `domain/qa-promotion.rules.ts`, evaluated by `QaProjectDeliveryService.evaluateGate` for the Project's current Iteration. For a repository R filed under Project P:

1. Read the `uat` head of every repository of P with a linked provisioned project (in parallel).
2. Find L, the **latest signed-off run** of the Iteration: the run whose active sign-off has the greatest `signed_at`. Open runs never count.
3. R is eligible only when all hold:
   - every head was readable;
   - P has at least one active requirement in the Iteration, and L exists;
   - L's verdict is `APPROVED` (`REJECTED` and `CONDITIONAL` block);
   - L is current: it has a `qa_run_repositories` row for every repository of P, and each captured head equals the head now. Any repository moving, or joining P, makes L stale for all of them;
   - L passed every active item of the Iteration;
   - no requirement was created, edited, archived or had items changed after L's sign-off;
   - the Product owner accepted every item of L;
   - the Iteration is not delivered.
4. Otherwise `reasons` lists the failures, for example `Project run is stale: "api" moved from a1b2c3d to e4f5a6b`, `Latest sign-off is Rejected`, `Could not read the uat head of "web"`, `No QA run covers the current uat heads`, `Requirements changed after QA signed off: a Product owner reopens the run so QA verifies them`, `2 items are waiting for the Product owner to pass them`.

A later Rejected sign-off on newer heads blocks even if an older run was approved. Merging one repository does not move its `uat` head, so the other repositories stay eligible after the first one merges.

### 3.2 Routes

- `GET /projects/:projectId/qa/promotion` returns `qaBranch`, `targetBranch`, `headSha`, `scope` (`project` or `unfiled`), `deliveryProject`, `run` (`{ id, verdict, signedAt, stale }`), `repositories: HeadStatus[]`, `requirementsChanged`, `eligible`, `reasons`, `pullRequest`, `repositoryDelivered`, `iterationDelivered`, `iteration`, `reasonCodes`, `canMerge`, and the deprecated `checklists` (one entry per requirement, each carrying the Project-level result).
- `POST /projects/:projectId/qa/promotion/merge` (lead, admin) recomputes the gate server-side. It answers 409 `QA_PROJECT_REQUIRED` for an unfiled repository, 409 `ITERATION_DELIVERED`, 409 `QA_PROMOTION_BLOCKED` with `reasons`, 409 `QA_UAT_MOVED` when the promotion pull request's head moved, and 409 `GITHUB_REAUTH` without a usable credential. GitHub writes go out as the ALPHACI GitHub App; the person's token is only the fallback. The reply says `how`: `merged`, or `already_in_main` when `main` already holds the signed-off head.
- `POST /delivery-projects/:dpId/promotion/merge-all` (lead, admin) merges every covered repository in a stable order, keeps going after a failure, and reports a result per repository. 409 `PROJECT_HAS_NO_REPOSITORIES` without a linked repository.

Each delivered repository is recorded in the Iteration's `delivery_json`. When every covered repository is in, the Iteration becomes `delivered`, records `qa.iteration.delivered` and notifies the workspace leads, Developers and QA. A merge records `qa.promotion.merged` with `deliveryProjectId` and `runId`.

### 3.3 Repositories not filed under a Project

A repository with no `hierarchy.repositories` row has no Project, no requirements and no run. Its gate is blocked with `This repository is not filed under a Project; QA requirements belong to Projects`, and merge answers 409 `QA_PROJECT_REQUIRED`. A lead files it with "Move repository between folders". There is no per-repository fallback.

## 4. Persona rules, notifications, legacy endpoints

### 4.1 Persona rules (allow-lists)

All checks are allow-lists, never "not member". Functions in `domain/qa-run-access.rules.ts` (`canManageRequirements` comes from `src/kernel/rules/persona-access.rules.ts`):

| Function | Allowed roles | Gates |
|---|---|---|
| `canManageRequirements` | lead, admin | requirement writes |
| `canSetProgress` | member, lead, admin | Progress; QA does not set it |
| `canSetVerification` | qa, lead, admin | run item Verification |
| `canManageTestCases` | qa, admin | test case categories and test cases |
| `canRecordTestCaseResults` | qa, admin | test case results in a run |
| `canAcceptRunItems` | lead, admin | Product owner acceptance |
| `canCreateRun`, `canSignOff`, `canDispatchAutomation`, `canAddEvidence` | qa, lead, admin | run lifecycle and evidence |
| `canReopenRun`, `canMergeQaPromotion`, `canRemoveAnyAttachment` | lead, admin | reopen, merge to main, deleting another person's attachment |
| `canRequestRetest` | member, lead, admin | the legacy `request-retest` alias |

Starting an Iteration uses `QaAccessService.canManage` (lead, admin). `personaAllowsRole` and `targetPersona` gate nothing on Project runs; the column remains as data on legacy rows. Platform admins resolve to `admin` and keep every action.

### 4.2 Notifications

Delivery is through `NotificationEventPublisher` with an explicit `@Inject` token. `projectId` on a notification is the Project's repository with a `frontend` deployment target (read through the runtime-owned `DEPLOYMENT_TARGETS_QUERY` port), oldest first, else its oldest linked repository. The actor never notifies themselves.

| Trigger | Event code | Recipients |
|---|---|---|
| Progress set to `done` | `qa.item.retest_requested` | workspace QA members and the previous verifier of a re-queued run item; title `Ready for QA: "<item>"` |
| Verification set to `failed` | `qa.item.failed` | repository owner, workspace leads, every Developer; only on the change itself |
| Sign-off | `qa.run.signed_off` | run creator, repository owner, workspace leads |
| Product owner fails an item | `qa.item.po_rejected` | run creator, signer, repository owner, workspace QA, leads and Developers |
| Iteration started | `qa.iteration.started` | workspace leads, Developers and QA |
| Iteration delivered | `qa.iteration.delivered` | workspace leads, Developers and QA |
| Merge to main | `qa.promotion.merged` | workspace leads |

Rows written before `blocked` and `returned_to_dev` were retired still map to `qa.item.blocked` and `qa.item.returned_to_dev` in the code, but nothing sets those statuses on Project runs.

### 4.3 Legacy endpoints

These remain for the frontend that predates Project requirements. They are deprecated.

| Endpoint | Behaviour |
|---|---|
| `GET /workspaces/:ws/qa-checklists`, `GET /qa-checklists/:id`, `GET /projects/:id/qa-checklists` | responses carry `kind`, `deliveryProjectId`, `legacyChecklistId`, item `acceptanceCriteria` and `progress`; the per-repository list returns the requirements of the repository's Project |
| `POST /workspaces/:ws/qa-checklists` | creates an unassigned `system` row only |
| `PATCH`, `PUT :id/items`, `POST :id/archive`, `PUT/PATCH :id/projects` | work on unassigned rows; on rows with a `delivery_project_id`: 409 `REQUIREMENT_MOVED_TO_PROJECT` (the delete-and-reinsert item replace would destroy Progress) |
| `GET /projects/:id/qa-runs`, `/current`, `/:runId`, `/:runId/report` | repository-scope runs only, as read-only history; each carries `legacy: true` |
| `POST /projects/:id/qa-runs`, `PATCH .../items/:itemId`, `signoff`, `reopen`, `automation/dispatch` | 409 `QA_RUN_LEGACY_READONLY`; creating a repository-scope run is refused the same way, with `projectRunsUrl` |
| `POST .../items/:itemId/request-retest` | on a Project run item: sets the item's Progress to `done` (same effects and notification); on a legacy run: 409 `QA_RUN_LEGACY_READONLY` |
| `GET /projects/:id/qa-my-items`, `/qa-returned-items` | derived from the repository's Project (`returned`; `developerItems` = `inProgress` + `todo`) |

## 5. Migration order

- A migration that adds columns the backend reads is applied before the backend deploys. The requirements, test case and acceptance migrations are additive, so code deployed earlier keeps working on the new schema.
- `20261015010000_project_iterations.sql` is not additive for code that predates Iterations: after it, that code cannot create a Project run or a Project requirement. Apply it immediately before the backend that uses it.
- Run `node scripts/apply-all-migrations.mjs --dry-run` and `npm run check:schema-ownership` first. Each file runs in one transaction, so a failure leaves the schema unchanged.

## 6. Design decisions and risks

### 6.1 Decisions

1. **Passed requires Done.** `passed` on a run item whose source item's Progress is not `done` is refused (409 `QA_PROGRESS_NOT_DONE`). `failed` and `pending` stay allowed at any Progress.
2. **Strict staleness.** Any repository of the Project moving its `uat` head, or a repository joining the Project, makes the latest signed-off run stale for every repository. The QA'd combination changed, so the sign-off no longer describes what would ship.
3. **Unfiled repositories are blocked** (section 3.3).
4. **Requirement changes after a sign-off block the merge.** The run, `current` and `GET .../qa/promotion` expose `requirementsChanged: true`; a Product owner reopens the run so QA verifies the change. A delivered Iteration therefore never holds unverified work, and the next Iteration starts empty.
5. **Notifications anchor on the frontend repository first** (section 4.2).
6. **Failed returns the story.** QA has three Verification values; `failed` always sends the story back to the Developers, and a run cannot be signed off while one is open.

### 6.2 Risks

| Risk | Mitigation |
|---|---|
| Edits destroy Progress (legacy item replace deletes and reinserts) | edit by item id only; legacy replace refused on Project rows |
| Backfill assigns the wrong Project when a checklist is shared across Projects | deterministic order (Project `created_at`, then id); copies carry `legacy_checklist_id` |
| N GitHub reads per gate evaluation | parallel reads with a per-repository failure reason; display paths reuse a reading up to 15 to 30 seconds old, merge paths read fresh |
| Silent undefined injection of the optional notification sink | explicit `@Inject(Class)` token and the boot test in `tests/architecture/http-boot.spec.ts` |
| Undecorated domain classes get no constructor args | rule modules are plain functions |
| Deleting a Project leaves orphan requirements | `DELIVERY_PROJECT_DATA_CLEANUP` port; unassigned rows are never deleted by it |

### 6.3 Tests

Unit specs sit beside the code in `src/modules/projects/` (`domain/qa-run-access.rules.spec.ts`, `domain/qa-promotion.rules.spec.ts`, `domain/qa-my-items.rules.spec.ts`, `domain/project-iteration.rules.spec.ts`, the `qa-*` and `project-iteration*` service, repository and controller specs). Migration integration specs run against a real database: `tests/integration/project-requirements.migration.integration.spec.ts`, `qa-test-cases.migration.integration.spec.ts` and `qa-po-acceptance.migration.integration.spec.ts`.

## 7. Test cases under a User story

QA writes how a story is tested: categories of test cases ("Happy path", "Validation", "Session") under a User story, and the test cases inside them. A run records QA's result per test case.

### 7.1 Model

| Table | Holds | Key points |
|---|---|---|
| `qa_test_case_categories` | `item_id` (the story, cascade), `position`, `name` (1 to 120), `row_version` | unique `(item_id, lower(name))`; at most 30 per story |
| `qa_test_cases` | `category_id` (cascade), `position`, `title` (1 to 300), `expected_result` (max 2000), `row_version` | at most 100 per category |
| `qa_run_test_cases` | `run_id`, `run_item_id` (cascade), `source_test_case_id` / `source_category_id` (SET NULL), snapshot of category name and position, title, expected result, `status`, `notes`, verifier, `row_version` | unique `(run_item_id, source_test_case_id)` is the sync's upsert key; a verifier is set exactly when `status <> 'pending'` |

### 7.2 Rules

- **Who:** `canManageTestCases` (qa, admin) writes definitions, others get `403 TEST_CASE_MANAGE_FORBIDDEN`. `canRecordTestCaseResults` (qa, admin) records results, others get `403 TEST_CASE_RESULT_FORBIDDEN`; the Product owner reads them. Non-members of the group get 404.
- **Which items:** items of a `functional` requirement only (`409 TEST_CASES_STORY_ONLY`). Archived Features and delivered Iterations refuse writes.
- **Results:** `pending`, `passed` or `failed`. `blocked` and `not_applicable` answer 400; rows written before keep them, and `not_applicable` counts as resolved.
- **Open runs follow the definitions.** `syncOpenRunTestCases(client, iterationId)` runs in the same transaction as every definition write, after `appendMissingItemsToOpenRuns`, and after a new run is created. It locks the open runs FOR SHARE, then the affected run items FOR UPDATE in id order, deletes copies whose definition is gone, upserts the rest (an unchanged copy is not rewritten; an edit never resets a result), and bumps `row_version` of every run item it changed. Signed-off runs are never touched.
- **Strict pass:** `passed` on a run item is refused while any of its test cases is `pending`, `failed` or `blocked` (`409 QA_TEST_CASES_OPEN` with `openTestCases`).
- **Sign-off:** `APPROVED` is refused while any test case of the run is open (same code), since one can be added or re-marked after its story passed. Lock order is run, then run item, then test case; a result write bumps its run item's `row_version`, so the sign-off fingerprint refuses a sign-off that raced one.

### 7.3 API

Every definition write answers the story's whole set: `{ itemId, testCategories: [{ id, position, name, rowVersion, testCases: [{ id, position, title, expectedResult, rowVersion }] }] }`.

| Method and path | Body | Notes |
|---|---|---|
| `POST /requirements/:id/items/:itemId/test-categories` | `{ name }` | 201; `409 TEST_CATEGORY_NAME_TAKEN`, `409 TEST_CASES_LIMIT` |
| `PATCH /requirements/:id/items/:itemId/test-categories/:categoryId` | `{ name, expectedRowVersion }` | `409 TEST_CASE_STALE` |
| `DELETE /requirements/:id/items/:itemId/test-categories/:categoryId` | none | deletes its test cases too |
| `POST /requirements/:id/items/:itemId/test-categories/:categoryId/test-cases` | `{ title, expectedResult? }` | 201 |
| `PATCH /requirements/:id/items/:itemId/test-cases/:testCaseId` | `{ expectedRowVersion, title?, expectedResult? }` | `null` clears the expected result |
| `DELETE /requirements/:id/items/:itemId/test-cases/:testCaseId` | none | |
| `PATCH /delivery-projects/:dpId/qa-runs/:runId/items/:itemId/test-cases/:testCaseId` | `{ expectedRowVersion, status?, notes? }` | answers the whole run, like an item write; `409 TEST_CASE_STALE` |

Reads: `RequirementItem.testCategories`, `permissions.canManageTestCases` on the requirement list, `ProjectQaRunItem.testCategories` (`[{ id | null, name, rowVersion, testCases: [{ id, sourceTestCaseId, position, title, expectedResult, status, notes, verifiedBy, verifiedAt, rowVersion, definitionRowVersion }] }]`; an open run also lists categories with no test case yet), and `permissions.canManageTestCases` and `permissions.canRecordTestCases` on a run (open run, qa or admin). The QA report (JSON, Markdown, Excel) carries the test cases; reports frozen before test cases existed have no `testCategories` key.

## 8. Product owner acceptance

After QA signs a Project run off as `APPROVED` or `CONDITIONAL`, a Product owner or admin checks each item.

`PATCH /delivery-projects/:dpId/qa-runs/:runId/items/:itemId/acceptance` with `{ decision: 'passed'|'failed', expectedRowVersion, notes?, defectSeverity? }`:

- The run must be signed off and not `REJECTED` (409 otherwise); others get 403. A stale `expectedRowVersion` answers 409 `QA_ITEM_STALE`.
- `passed` sets `po_status = 'passed'` with `po_by`, `po_by_login` and `po_at`, and records `qa.item.po_accepted`.
- `failed` needs notes (400). It reopens the run (the sign-off is superseded, as on Reopen), adds any item the Iteration holds but the run lacks, and sets the item `failed` with the notes prefixed "Product owner:" and the given severity (default `major`). That returns the story to the Developers like any QA failure. It records `qa.run.reopened` and `qa.item.po_rejected` and notifies as in section 4.2. QA re-checks the story once a Developer marks it Done, and signs off again.
- Any QA status write resets the item's acceptance to `pending`.

A run item carries `poAcceptance: { status: 'pending'|'passed', acceptedBy, acceptedAt }` and the run carries `permissions.canAccept`. Merge to main waits until every item of the latest signed-off run is accepted (section 3.1).
