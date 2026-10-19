---
type: "Design Specification"
title: "Project requirements"
description: "Design for Project-owned functional and system requirements, two-track progress and verification, Project-level QA runs, and the per-Project merge-to-main gate."
tags: [design, projects, qa, requirements, migrations]
status: stable
---
# Project requirements

**Status:** Implemented in the backend (approved 2026-10-01, decisions in 6.3). Recorded as [ADR-0014](../architecture/decisions/adr-0014-project-requirements.md).
**Builds on:** [ADR-0013 QA verification runs](../architecture/decisions/adr-0013-qa-verification-runs.md).

Terminology. In QA code, "project" means a `projects.provisioned_projects` row, which is one repository. A "Project" in the product (API term `delivery-project`, SQL `hierarchy.delivery_projects`) is the folder that owns one or more repositories. This document writes "repository" for the first and "Project" for the second.

## Summary of decisions

1. A Project owns its requirements. There are two kinds: `functional` (a Feature whose items are User stories) and `system` (a flat checklist). Every existing checklist becomes a `system` requirement.
2. Requirements apply to every repository in the Project automatically. The per-repository share table is legacy and ignored for new data.
3. Each item has two independent tracks: **Progress** (`todo`, `in_progress`, `done`) set by developers, leads and admins; **Verification** (`pending`, `passed`, `failed`, `blocked`, `returned_to_dev`) set by QA, leads and admins.
4. QA verifies once per Project. A Project run captures the `uat` head SHA of every repository when it starts.
5. A repository may merge `uat` to `main` only when the latest signed-off Project run is `APPROVED` and still current for every repository in the Project.
6. The existing tables are extended in place (no renames), so the migration is additive and the deployed code keeps working until the new code ships. The migration is applied **before** the backend deploy.

## 1. Schema and migration

### 1.1 Model

| Concept | Table | Change |
|---|---|---|
| Requirement | `projects.qa_checklists` | add `kind`, `delivery_project_id`, `legacy_checklist_id`; scope-aware unique name index |
| Requirement item (story or checklist item) | `projects.qa_checklist_items` | add `acceptance_criteria`, Progress columns, `row_version`, `updated_at` |
| Project run | `projects.qa_verification_runs` | add `scope`, `delivery_project_id`, `heads_fingerprint`; `project_id` and `commit_sha` become nullable |
| Heads captured at run start | `projects.qa_run_repositories` | new |
| Run item snapshot | `projects.qa_run_items` | add `requirement_id`, `requirement_name`, `requirement_kind`, `acceptance_criteria` |
| Sign-off, events | `projects.qa_run_signoffs`, `projects.qa_run_item_events` | unchanged, reused by Project runs |
| Legacy sharing | `projects.qa_checklist_projects` | untouched, no longer read for requirements that have a `delivery_project_id` |

Why extend rather than add tables: the run, item, event, sign-off, report and row-locking machinery (about 1,200 lines in `qa-runs.service.ts`) works on `run_id` and does not care whether a run covers one repository or many. Existing runs keep their foreign keys and stay as history with `scope = 'repository'`. Table names keep the `qa_checklist` prefix; API and docs use "requirement".

Progress lives on the requirement item (definition), not on the run item, because it persists across runs and across rebuilds of `uat`. Verification lives on the run item because it is a verdict about specific commits.

### 1.2 Ownership and RLS

- `delivery_project_id` is a plain UUID with no foreign key, the same pattern as `workspace_id`: the `projects` context may only reference the `projects` and `workflow` schemas (`scripts/check-schema-ownership.cjs`).
- Runtime reads of `hierarchy.*` go through a **port, not an exemption**. `ProjectLinkPort` (already consumed by Projects) gains `getDeliveryProject(deliveryProjectId): Promise<ProjectFolderLink | null>`, the reverse of the existing `getProjectFolder(projectId)`. It returns the group id, name and non-archived repositories with their provisioned project ids. No new inline-SQL entries are added to the gate.
- Deleting a Project must remove its requirements. A new kernel port `DELIVERY_PROJECT_DATA_CLEANUP`, implemented by Projects (same shape as `WORKSPACE_DATA_CLEANUP`) and called by `DeliveryProjectsService` on delete, archives or deletes requirements; runs stay as history because their snapshot is self-contained.
- The **migration** cannot use a port. It reads `hierarchy.repositories` and `hierarchy.delivery_projects` for the backfill, so the migration needs two exact-pair entries in `LEGACY_MIGRATION_REFERENCES` for `projects/20261001010000_project_requirements.sql`: `hierarchy.repositories` and `hierarchy.delivery_projects`. This is the same kind of reviewed transition entry the hierarchy migrations already have for `projects.provisioned_projects`. No whole-file exemption.
- New tables enable RLS and `REVOKE ALL ... FROM anon, authenticated`, as in the QA slices.

### 1.3 Migration `supabase/migrations/projects/20261001010000_project_requirements.sql`

Single file, idempotent, every constraint inline or guarded so a cold replay and a re-run both succeed. Statement order matters: the name-index swap must precede the backfill, because duplicated names would violate the old index.

```sql
-- Project requirements: Project-owned functional/system requirements,
-- item acceptance criteria and Progress, Project-level QA runs.
-- Additive: deployed code keeps working against this schema.

-- 1. Requirements -------------------------------------------------------
ALTER TABLE projects.qa_checklists
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'system'
    CONSTRAINT qa_checklists_kind_chk CHECK (kind IN ('functional', 'system')),
  ADD COLUMN IF NOT EXISTS delivery_project_id UUID NULL
    CONSTRAINT qa_checklists_functional_scope_chk
      CHECK (kind <> 'functional' OR delivery_project_id IS NOT NULL),
  ADD COLUMN IF NOT EXISTS legacy_checklist_id UUID NULL
    REFERENCES projects.qa_checklists(id) ON DELETE SET NULL;

-- Names are unique per (workspace, Project scope, kind), so the same
-- checklist name can exist in two Projects. NULL scope = "unassigned".
DROP INDEX IF EXISTS projects.uq_qa_checklists_workspace_name_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_qa_requirements_scope_name_active
  ON projects.qa_checklists (
    workspace_id,
    COALESCE(delivery_project_id, '00000000-0000-0000-0000-000000000000'::uuid),
    kind,
    lower(name)
  )
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_qa_checklists_delivery_project
  ON projects.qa_checklists (delivery_project_id)
  WHERE delivery_project_id IS NOT NULL;

-- 2. Items: acceptance criteria + Progress track ---------------------------
ALTER TABLE projects.qa_checklist_items
  ADD COLUMN IF NOT EXISTS acceptance_criteria TEXT NULL
    CONSTRAINT qa_checklist_items_acceptance_criteria_length_chk
      CHECK (char_length(acceptance_criteria) <= 4000),
  ADD COLUMN IF NOT EXISTS progress TEXT NOT NULL DEFAULT 'todo'
    CONSTRAINT qa_checklist_items_progress_chk
      CHECK (progress IN ('todo', 'in_progress', 'done')),
  ADD COLUMN IF NOT EXISTS progress_by UUID NULL,
  ADD COLUMN IF NOT EXISTS progress_by_login TEXT NULL,
  ADD COLUMN IF NOT EXISTS progress_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 3. Runs: Project scope ---------------------------------------------------
ALTER TABLE projects.qa_verification_runs
  ALTER COLUMN project_id DROP NOT NULL,
  ALTER COLUMN commit_sha DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'repository'
    CONSTRAINT qa_verification_runs_scope_chk CHECK (scope IN ('repository', 'project')),
  ADD COLUMN IF NOT EXISTS delivery_project_id UUID NULL,
  -- sha256 hex of the sorted "<provisioned_project_id>:<head_sha>" lines.
  ADD COLUMN IF NOT EXISTS heads_fingerprint TEXT NULL
    CONSTRAINT qa_verification_runs_heads_fingerprint_chk
      CHECK (heads_fingerprint ~ '^[0-9a-f]{64}$');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'projects.qa_verification_runs'::regclass
      AND conname = 'qa_verification_runs_scope_shape_chk'
  ) THEN
    ALTER TABLE projects.qa_verification_runs
      ADD CONSTRAINT qa_verification_runs_scope_shape_chk CHECK (
        (scope = 'repository' AND project_id IS NOT NULL AND commit_sha IS NOT NULL)
        OR
        (scope = 'project' AND delivery_project_id IS NOT NULL
           AND project_id IS NULL AND heads_fingerprint IS NOT NULL)
      );
  END IF;
END $$;

-- One run per (Project, set of heads): the idempotency key for POST create.
CREATE UNIQUE INDEX IF NOT EXISTS uq_qa_runs_project_scope_heads
  ON projects.qa_verification_runs (delivery_project_id, heads_fingerprint)
  WHERE scope = 'project';
CREATE INDEX IF NOT EXISTS idx_qa_runs_project_scope_created
  ON projects.qa_verification_runs (delivery_project_id, created_at DESC)
  WHERE scope = 'project';

CREATE TABLE IF NOT EXISTS projects.qa_run_repositories (
  run_id UUID NOT NULL REFERENCES projects.qa_verification_runs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  repo_full_name TEXT NOT NULL,
  head_sha TEXT NOT NULL
    CONSTRAINT qa_run_repositories_head_sha_chk
    CHECK (head_sha ~ '^[0-9a-f]{40}$' OR head_sha ~ '^[0-9a-f]{64}$'),
  CONSTRAINT qa_run_repositories_pkey PRIMARY KEY (run_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_qa_run_repositories_project
  ON projects.qa_run_repositories (project_id);

ALTER TABLE projects.qa_run_items
  ADD COLUMN IF NOT EXISTS requirement_id UUID NULL
    REFERENCES projects.qa_checklists(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS requirement_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS requirement_kind TEXT NULL
    CONSTRAINT qa_run_items_requirement_kind_chk
      CHECK (requirement_kind IN ('functional', 'system')),
  ADD COLUMN IF NOT EXISTS acceptance_criteria TEXT NULL;

ALTER TABLE projects.qa_run_repositories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON projects.qa_run_repositories FROM anon, authenticated;

-- 4. Backfill: each shared system checklist -> one system requirement per
-- Project its shared repositories belong to. The original row is assigned to
-- the first Project (keeps its id, so old runs stay linked); other Projects
-- get a copy. Unshared checklists are untouched (delivery_project_id NULL =
-- "unassigned"). qa_checklist_projects is left as-is (legacy, read by the
-- deployed code until it is replaced). Re-running copies nothing twice.
DO $$
DECLARE
  pair RECORD;
  v_current UUID;
  v_name TEXT;
  v_copy_id UUID;
BEGIN
  FOR pair IN
    SELECT DISTINCT c.id AS checklist_id, dp.id AS dp_id, dp.created_at AS dp_created
    FROM projects.qa_checklists c
    JOIN projects.qa_checklist_projects s ON s.checklist_id = c.id
    JOIN hierarchy.repositories hr
      ON hr.provisioned_project_id = s.project_id AND hr.status <> 'archived'
    JOIN hierarchy.delivery_projects dp
      ON dp.id = hr.delivery_project_id
     AND dp.status = 'active'
     AND dp.group_id = c.workspace_id
    WHERE c.archived_at IS NULL
      AND c.kind = 'system'
      AND c.legacy_checklist_id IS NULL
    ORDER BY c.id, dp.created_at, dp.id
  LOOP
    SELECT delivery_project_id, name INTO v_current, v_name
      FROM projects.qa_checklists WHERE id = pair.checklist_id;

    IF v_current = pair.dp_id THEN
      CONTINUE;
    END IF;

    IF v_current IS NULL THEN
      UPDATE projects.qa_checklists
         SET delivery_project_id = pair.dp_id, updated_at = NOW()
       WHERE id = pair.checklist_id AND delivery_project_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM projects.qa_checklists x
           WHERE x.delivery_project_id = pair.dp_id AND x.kind = 'system'
             AND x.archived_at IS NULL AND lower(x.name) = lower(v_name));
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM projects.qa_checklists x
      WHERE x.legacy_checklist_id = pair.checklist_id
        AND x.delivery_project_id = pair.dp_id
    ) THEN
      CONTINUE;
    END IF;

    v_copy_id := NULL;
    INSERT INTO projects.qa_checklists
      (workspace_id, name, description, version, kind, delivery_project_id,
       legacy_checklist_id, created_by, created_at)
    SELECT workspace_id, name, description, 1, 'system', pair.dp_id,
           id, created_by, created_at
      FROM projects.qa_checklists WHERE id = pair.checklist_id
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_copy_id;

    IF v_copy_id IS NOT NULL THEN
      INSERT INTO projects.qa_checklist_items
        (checklist_id, "position", title, description, target_persona,
         verification_type, test_identifier)
      SELECT v_copy_id, "position", title, description, target_persona,
             verification_type, test_identifier
        FROM projects.qa_checklist_items WHERE checklist_id = pair.checklist_id;
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN projects.qa_checklists.kind
  IS 'functional = Feature with User stories; system = flat checklist.';
COMMENT ON COLUMN projects.qa_checklists.delivery_project_id
  IS 'Owning Project (hierarchy.delivery_projects.id). No FK: cross-context. NULL = unassigned legacy system checklist.';
COMMENT ON TABLE projects.qa_run_repositories
  IS 'uat head SHA of each repository captured when a Project run started.';
```

A matching `supabase/rollbacks/20261001010000_project_requirements_down.sql` drops the new table and columns and restores the old index. It must fail closed if any `scope = 'project'` run or `kind = 'functional'` requirement exists, because the old schema cannot hold them.

Prod check (2 checklists, 4 items, 4 shares, 3 runs): "TestChecklist" ends as two system requirements (original plus one copy), "John's Password" as one. Both original ids keep their runs. Run `--dry-run` first, and before applying, count repositories that have legacy shares but no `hierarchy.repositories` row (see section 3, unfiled repositories).

### 1.4 Status columns used by the new code

- Item `progress`: `todo`, `in_progress`, `done`. `done` means ready for QA.
- Run item `status` keeps its existing CHECK. New writes never use `in_progress`; allowed values are `pending`, `passed`, `failed`, `blocked`, `returned_to_dev`.
- Project run rows: `branch = 'uat'`, `commit_source = 'branch_head'`, `commit_sha` NULL, `checklist_id` NULL, `checklist_version` 0, `checklist_name` = the Project name at run start.
- Run item `position` is global across the run: requirements in order (functional first, then system, by creation), items by position.

## 2. API contract

All routes sit behind `@RequiresCapability('projects.qa-checklists')` (no new capability: a new key would need the capability ledger, the generated matrix and the frontend catalog kept in sync, and the `apiField` in `GET /capabilities` has been missed before). Visibility: the caller must be an active member of the Project's group (`QaAccessService.canAccessWorkspace`), else 404. The Project and its group come from `ProjectLinkPort.getDeliveryProject`. Errors use the existing shape `{ statusCode, code?, message, reasons? }`.

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

| Route | Who | Body / result |
|---|---|---|
| `GET /delivery-projects/:dpId/requirements?kind=&includeArchived=` | any group member | `{ deliveryProject: {id,name,groupId}, requirements: Requirement[], permissions: { canManage, canSetProgress } }` |
| `POST /delivery-projects/:dpId/requirements` | lead, admin | `{ kind, name, description?, items?: [{title, acceptanceCriteria?, verificationType?, testIdentifier?}] }` -> 201 `Requirement` |
| `GET /requirements/:id` | any group member | `Requirement` |
| `PATCH /requirements/:id` | lead, admin | `{ name?, description?, expectedVersion }` -> `Requirement` (bumps `version`) |
| `POST /requirements/:id/archive` | lead, admin | `Requirement` |
| `POST /requirements/:id/items` | lead, admin | `{ title, acceptanceCriteria?, verificationType?, testIdentifier? }` -> 201 `RequirementItem`, appended |
| `PATCH /requirements/:id/items/:itemId` | lead, admin | `{ title?, acceptanceCriteria?: string\|null, verificationType?, testIdentifier?, expectedRowVersion }` -> `RequirementItem` |
| `DELETE /requirements/:id/items/:itemId` | lead, admin | 204; open run items keep their snapshot (`source_item_id` set null) |
| `PUT /requirements/:id/items/order` | lead, admin | `{ itemIds: string[] }`, must be exactly the current set; positions rewritten in one transaction (the unique `position` constraint is deferrable) |

Edits are by item id and never delete-and-reinsert, so Progress survives. The legacy `PUT /qa-checklists/:id/items` (delete and reinsert) must not be called on migrated rows; see 4.3.

Errors: 400 `REQUIREMENT_KIND_INVALID`, 400 `REQUIREMENT_ORDER_MISMATCH`, 403 `REQUIREMENT_MANAGE_FORBIDDEN`, 404 (not a member or not found), 409 `REQUIREMENT_NAME_TAKEN` (unique index), 409 `REQUIREMENT_STALE` (`expectedVersion`), 409 `REQUIREMENT_ITEM_STALE` (`expectedRowVersion`), 409 `REQUIREMENT_ARCHIVED`.

### 2.3 Progress

`PATCH /requirements/:id/items/:itemId/progress` (member, lead, admin)

```json
{ "progress": "done", "expectedRowVersion": 3, "note": "optional, max 1000" }
```

Returns `{ item: RequirementItem, readyForQaNotified: boolean }`. Any transition among the three values is allowed (a developer can reopen their own mistake). Transaction: lock the item row, check `row_version`, update `progress`, `progress_by*`, bump `row_version`. If the new value is `done` and an open Project run has this item's run item in `returned_to_dev`, that run item is set to `pending` with `fix_requested_*` filled (the existing `requestRetest` repository method, lock order run row then item row). Errors: 403 `PROGRESS_FORBIDDEN` (qa), 409 `REQUIREMENT_ITEM_STALE`, 409 `REQUIREMENT_ARCHIVED`.

### 2.4 Project runs

Project runs live under the Project. The server resolves the heads; the client never sends a SHA (ADR-0013 rule 4).

| Route | Who | Notes |
|---|---|---|
| `GET /delivery-projects/:dpId/qa-runs?limit&cursor` | group member | `{ runs: ProjectQaRunListItem[], next }`, project-scope runs only |
| `GET /delivery-projects/:dpId/qa-runs/current` | group member | `{ run: ProjectQaRun \| null, heads: HeadStatus[], stale: boolean }` for the current set of heads |
| `POST /delivery-projects/:dpId/qa-runs` | qa, lead, admin | no body. 201 `{ created: true, run }`, or 200 `{ created: false, run }` when a run for the same fingerprint exists |
| `GET /delivery-projects/:dpId/qa-runs/:runId` | group member | `ProjectQaRun` |
| `PATCH /delivery-projects/:dpId/qa-runs/:runId/items/:itemId` | qa, lead, admin | set Verification, below |
| `POST .../:runId/signoff` | qa, lead, admin | `{ verdict, summary?, conditions? }`, rules unchanged from ADR-0013 rule 7 |
| `POST .../:runId/reopen` | lead, admin | unchanged |
| `GET .../:runId/report?format=json\|markdown` | group member | `qa-report/v2`: v1 plus `repositories[]` (name, head SHA) and per-item requirement name and kind; frozen at sign-off |
| `POST .../:runId/automation/dispatch` | qa, lead, admin | body `{ projectId? }`; default dispatches the verify workflow in every covered repository with the caller's token |

```ts
interface HeadStatus { projectId: string; repoFullName: string;
  runSha: string | null; currentSha: string | null; moved: boolean; }
interface ProjectQaRun /* extends the existing QaRun */ {
  scope: 'project'; deliveryProjectId: string; deliveryProjectName: string;
  repositories: HeadStatus[];
  stale: boolean;                       // any repository moved or a repository was added
  requirementsChanged: boolean;         // informational, see section 6
  items: ProjectQaRunItem[];            // QaRunItem + requirementId, requirementName,
                                        // requirementKind, acceptanceCriteria, progress
  permissions: { canSetVerification, canSignOff, canReopen, canDispatch };
}
```

`POST` create: read `uat` head of each non-archived repository that has a linked provisioned project (installation token precedence as in `QaPromotionService.resolveReadToken`), fingerprint, `INSERT ... ON CONFLICT DO NOTHING` on `uq_qa_runs_project_scope_heads`, snapshot all non-archived requirements' items, set `prior_run_item_id` to the same source item in the newest earlier Project run. Errors: 409 `QA_NO_REQUIREMENTS`, 409 `QA_UAT_HEAD_UNREADABLE` (`reasons` lists repositories), 409 `QA_UAT_BRANCH_MISSING`, 409 `QA_NO_REPOSITORIES`.

Set Verification body: `{ status: 'pending'|'passed'|'failed'|'blocked'|'returned_to_dev', notes?, defectSeverity?, reproductionSteps?, expectedRowVersion }`. Rules unchanged: `failed` and `returned_to_dev` require a severity (400); `QA_ITEM_STALE`, `QA_RUN_CHANGED` 409 codes unchanged. New: 400 `QA_VERIFICATION_STATUS_INVALID` for `in_progress`; 403 `VERIFICATION_FORBIDDEN` for a developer; 409 `QA_PROGRESS_NOT_DONE` for `passed` while the source item's Progress is not `done` (6.3 decision 1). Setting `returned_to_dev` also sets the source item's Progress to `in_progress` in the same transaction (skipped when `source_item_id` is null).

### 2.5 My QA items (project-wide)

`GET /delivery-projects/:dpId/qa/my-items` (any group member; the UI shows it to developers and QA). No per-user filter: it lists every developer's items.

```ts
interface MyQaItems {
  returned: FeedItem[];     // current run item = returned_to_dev
  inProgress: FeedItem[];   // Progress = in_progress
  todo: FeedItem[];         // Progress = todo
  readyForQa: FeedItem[];   // Progress = done and run item pending (QA's queue)
}
interface FeedItem { requirement: {id,name,kind}; item: RequirementItem;
  runId: string | null; runItem: ProjectQaRunItem | null; }
```

Run items come from the open run for the current heads, or the newest open Project run if heads moved; `runItem` is null when none exists.

### 2.6 Checklists overview (team level, read-only)

`GET /workspaces/:workspaceId/qa-requirements/overview` (any workspace member)

```ts
{ groups: [{ deliveryProject: {id,name}, requirements: RequirementSummary[],
             latestRun: LatestRun | null,
             counts: { readyForQa: number,
                       openDefects: { blocker, major, minor, unrated },
                       members: { developer: number, qa: number } },
             promotion: { mergedRepositories, totalRepositories, lastMergedAt: iso | null } | null,
             viewerMembership: 'developer' | 'qa' | null }],
  unassigned: RequirementSummary[],
  permissions: { canManage } }
interface RequirementSummary { id; kind; name; itemCount;
  progressCounts; verification: { pending, passed, failed, blocked, returned_to_dev } | null;
  latestRunStatus: 'open'|'signed_off'|null; archivedAt }
interface LatestRun { id; status: 'open'|'signed_off'; createdAt: iso;
  verdict: 'APPROVED'|'REJECTED'|'CONDITIONAL' | null;   // current (non-superseded) sign-off; null while open
  signedOffAt: iso | null; signedOffBy: string | null }  // signer's GitHub login
```

`verification` is from the newest Project run of that Project, null when none. Groups come from `ProjectLinkPort` plus the requirement rows; Projects with no requirements are listed with an empty array.

The per-group fields after `requirements` are additive (the Checklists page ignores them; the Home dashboard reads them). Every one of them is read in a batch over all the team's Projects, so the number of database round trips does not grow with the number of Projects (constant: Projects, requirements, caller role, requirement items, newest runs with sign-offs, members and repositories via the hierarchy port, run items, and one audit read when some newest run is signed off).

- `latestRun` is the newest Project run (the same run `verification` is read from), null when the Project has none. `verdict`, `signedOffAt` and `signedOffBy` come from that run's active sign-off and are null while it is open.
- `counts.readyForQa` is the size of the `readyForQa` bucket of `GET /delivery-projects/:id/qa/my-items` (section 2.5), computed by the same function (`bucketMyQaItem`, `domain/qa-my-items.rules.ts`) over the Project's non-archived requirement items and the newest run's items; with no run every done item counts. **Known gap:** my-items picks its run from the live `uat` heads (the run for the current heads, else the newest open run); the overview makes no GitHub call, so it always reads the newest run. They agree when there is no run, when the newest run is open, and when no head has moved since the newest signed-off run. They differ only when the newest run is signed off and a head has since moved: my-items then has no run and lists every done item, the overview counts only the done items that run left undecided.
- `counts.openDefects` counts the newest run's items whose Verification is `failed`, `blocked` or `returned_to_dev`, by defect severity (a null severity is `unrated`); all zero with no run. A signed-off run still reports the defects it was signed off with.
- `counts.members` is the number of ACTIVE rows of `hierarchy.delivery_project_members` by `member_kind`; `viewerMembership` is the caller's own active row (null for leads and admins, who are never members, and for non-members). Both come through the `DELIVERY_PROJECT_OVERVIEW_QUERY` port.
- `promotion` is null unless `latestRun.status` is `signed_off`. Promotion is per repository, the run per Project, hence merged / total: `mergedRepositories` counts the Project's repositories that have a `qa.promotion.merged` audit event at or after `latestRun.signedOffAt`, `totalRepositories` the Project's non-archived repositories linked to an AlphaCI project (the only ones that can be promoted), `lastMergedAt` the newest such merge. It is also null when the merges cannot be read (audit recording is off, or the read failed), so the page says nothing about promotion rather than a misleading 0 merged.

## 3. Merge-to-main gate

Today `evaluateQaPromotionGate` is per repository: every checklist shared to that repository needs a signed-off `APPROVED` run on the repository's current `uat` head. The new rule is per Project and implemented as a new pure function `evaluateProjectPromotionGate` in `qa-promotion.rules.ts` (the old function stays for the unfiled fallback decision below and for its tests until removed).

### 3.1 Rule

For repository R filed under Project P, `QaPromotionService.computeStatus` does:

1. Resolve P through `ProjectLinkPort.getProjectFolder(R.id)`. Collect P's repositories with a linked provisioned project and read each `uat` head (parallel, same token precedence as today).
2. Find L = the **latest signed-off Project run** of P: the project-scope run whose active sign-off has the greatest `signed_at`. Open runs never count.
3. `eligible(R)` is true only if all hold:
   - every head was readable;
   - P has at least one non-archived requirement and L exists;
   - L's active verdict is `APPROVED` (`REJECTED` and `CONDITIONAL` block, as today);
   - L is **current**: L has a `qa_run_repositories` row for every repository of P, and each row's `head_sha` equals that repository's current `uat` head. If any repository moved, or a repository was added to P since, L is stale for all repositories.
4. Otherwise `eligible` is false and `reasons` explains the first failures, for example `Project run is stale: "api" moved from a1b2c3d to e4f5a6b`, `Latest sign-off is Rejected`, `Could not read the uat head of "web"`, `No QA run covers the current uat heads`.

Using the latest signed-off run (not any approved run) means a later Rejected sign-off on newer heads blocks even if an older run was approved. A single-repository Project degenerates to today's behavior: one head, one run, same verdict rule.

Merging one repository does not move its `uat` head (the merge commit lands on `main`), so the other repositories of P stay eligible after the first one merges.

### 3.2 Contract changes

`GET /projects/:projectId/qa/promotion` and `POST .../merge` keep their routes. The response adds, all additive:

```ts
scope: 'project' | 'unfiled';
deliveryProject: { id: string; name: string } | null;
run: { id: string; verdict: QaVerdict; signedAt: string; stale: boolean } | null;
repositories: HeadStatus[];
```

`checklists` stays populated for the deployed frontend: one entry per requirement of P, each with `approvedForHead` equal to the Project-level result, marked deprecated. `buildQaPromotionPullRequestBody` is fed the same entries and additionally lists the run id and covered repositories. `merge` recomputes the gate server-side exactly as today, keeps the `QA_UAT_MOVED` check on the PR head SHA, and keeps the 409 `QA_PROMOTION_BLOCKED` with `reasons`. Merge audit metadata gains `deliveryProjectId` and `runId`.

### 3.3 Repositories not filed under a Project

A repository with no `hierarchy.repositories` row has no Project, so it has no requirements and no run. Decision: its gate is **blocked** with reason `This repository is not filed under a Project; QA requirements belong to Projects`, 409 `QA_PROJECT_REQUIRED` on merge. A lead fixes it with the existing "Move repository between folders" action. No legacy per-repository fallback is kept: it would keep the old runs live and contradict "existing runs are read-only history". Pre-flight (section 5) counts repositories that have legacy shares and no hierarchy row so none is stranded unexpectedly.

## 4. Notifications, persona rules, existing endpoints

### 4.1 Persona rules (allow-lists)

All checks stay allow-lists, never "not member" (ADR-0013 rule 2). New or changed functions in `qa-run-access.rules.ts`:

| Function | Allowed roles | Notes |
|---|---|---|
| `canManageRequirements` | lead, admin | same set as `QaAccessService.canManage` (includes platform admins) |
| `canSetProgress` | member, lead, admin | QA cannot set Progress |
| `canSetVerification` | qa, lead, admin | replaces `personaAllowsRole`; developers lose it |
| `canSetReturnedToDev` | qa, lead, admin | unchanged |
| `canCreateRun`, `canSignOff`, `canDispatchAutomation` | qa, lead, admin | unchanged |
| `canReopenRun`, `canMergeQaPromotion` | lead, admin | unchanged |
| `canRequestRetest` | member, lead, admin | kept only for the compatibility alias in 4.3 |
| `canManageTestCases` | qa, admin | test case categories and test cases under a User story (section 7) |

`personaAllowsRole` and `targetPersona` stop gating anything for Project runs. The column remains as data on legacy rows. Admins keep every action. Update `PERSONA_WORKFLOW_SPEC.md` (Verification Execution, QA Checklists, My QA items and Release Promotion rows) in the implementation change.

### 4.2 Notifications

Events keep their codes so the inbox and the frontend mapping do not change. Delivery is through `NotificationEventPublisher` with the explicit `@Inject` token. `projectId` on a notification is the Project's frontend repository, else its oldest linked repository (decision 5 in 6.3; the deep-link join in the notifications repository goes repository to folder); the body names the Project.

| Trigger | Event code | Recipients (minus actor) |
|---|---|---|
| Progress set to `done` | `qa.item.retest_requested` | workspace QA members, plus the previous verifier of that item if any. Fires even when no run item is returned, with title `Ready for QA: "<item>"` |
| Verification `returned_to_dev` | `qa.item.returned_to_dev` | project owner, workspace leads and developers. The best-effort commit-author lookup is dropped for Project runs because a run covers many repositories |
| Verification `blocked` with blocker severity | `qa.item.blocked` | workspace leads |
| Sign-off | `qa.run.signed_off` | run creator, owner, workspace leads |
| Merge to main | `qa.promotion.merged` | workspace leads, unchanged |

### 4.3 Existing endpoints: keep or deprecate

Rule for the whole table: additive for one release, then remove after the frontend has shipped on the new routes.

| Existing | Disposition |
|---|---|
| `GET /workspaces/:ws/qa-checklists`, `GET /qa-checklists/:id`, `GET /projects/:id/qa-checklists` | keep, deprecated. Responses gain `kind`, `deliveryProjectId`, `legacyChecklistId`, item `acceptanceCriteria`, `progress`. The per-repository list now returns the requirements of the repository's Project |
| `POST /workspaces/:ws/qa-checklists` | keep, deprecated; creates an unassigned `system` row only |
| `PATCH`, `PUT :id/items`, `POST :id/archive`, `PUT/PATCH :id/projects` | keep for unassigned rows. For rows with a `delivery_project_id`: 409 `REQUIREMENT_MOVED_TO_PROJECT` (the delete-and-reinsert item replace would destroy Progress) |
| `GET /projects/:id/qa-runs`, `/current`, `/:runId`, `/:runId/report` | keep. Return repository-scope runs only, as read-only history; each carries `legacy: true` |
| `POST /projects/:id/qa-runs`, `PATCH .../items/:itemId`, `signoff`, `reopen`, `automation/dispatch` | on a repository-scope run: 409 `QA_RUN_LEGACY_READONLY`. Creating a repository-scope run is refused the same way, with `projectRunsUrl` |
| `POST .../items/:itemId/request-retest` | alias on Project runs: sets the item's Progress to `done` (same effects and notification). Legacy runs: 409 `QA_RUN_LEGACY_READONLY` |
| `GET /projects/:id/qa-my-items`, `/qa-returned-items` | keep, deprecated: derived from the repository's Project (`returned`; `developerItems` = `inProgress` + `todo`) |
| `GET /projects/:id/qa/promotion`, `POST .../merge` | keep, extended (section 3) |

The frontend migrates to: requirements CRUD, Progress, Project runs, Project-wide My QA items, the overview, and the extended promotion response.

## 5. Rollout

**Decision: apply the migration BEFORE deploying the backend.**

Why:

- The new code selects and writes `kind`, `delivery_project_id`, `progress`, `scope` and the coverage table. Deployed first, every QA endpoint and the Merge-to-main gate would fail with a missing-column error until the migration ran. ADR-0013 already records the same rule ("deploying code that writes a new column requires its migration first").
- The migration is additive, so the deployed code keeps working on the new schema. Checked against the deployed code paths: new columns have defaults; `project_id` and `commit_sha` are nullable but no Project run exists yet, so no deployed query meets a NULL; the old name index is replaced by a looser scope-aware one, and the deployed duplicate-name check is a pre-query, not a reliance on the index name; the backfill leaves `qa_checklist_projects` untouched, so every repository still resolves its shared checklists, and the Merge-to-main gate and existing runs behave as before.
- Visible side effects of the in-between period: the team checklist list shows a migrated checklist twice (one per Project) under the same name; creating a checklist or sharing one works as before.

Order:

1. Pre-flight (read-only): `node scripts/apply-all-migrations.mjs --dry-run`; `npm run check:schema-ownership`; count unfiled repositories with legacy shares (`qa_checklist_projects` rows whose `project_id` has no `hierarchy.repositories` row) and file them first if any; record the counts of checklists, items, shares and runs (expected 2, 4, 4, 3).
2. Apply: `node scripts/apply-all-migrations.mjs --from 20261001010000_project_requirements.sql` (direct connection on 5432). The file runs in one transaction, so a failure leaves the schema unchanged.
3. Verify with SQL: system requirements with a `delivery_project_id` equal the expected pairs (TestChecklist in 2 Projects, John's Password in 1); item counts of copies equal their originals; no `kind = 'functional'` rows; old runs still `scope = 'repository'`.
4. Deploy the backend. Smoke: `GET /delivery-projects/:id/requirements`, the promotion status of one repository, a legacy run read.
5. Re-run the same `--from` command once after the deploy. The backfill is idempotent and catches checklists shared by the deployed code during the window; after the new backend is live no new legacy share is possible.
6. Deploy the frontend. Remove the deprecated routes in a later release, with a second migration dropping `qa_checklist_projects` only after nothing reads it.

Rollback: the down file fails closed once Project runs or functional requirements exist. Before any such data exists, backend rollback alone is safe because the schema is a superset.

Documentation changes in the implementation change: ADR-0014 (Project requirements), `PERSONA_WORKFLOW_SPEC.md`, `docs/log.md`, `CHANGELOG.md`, the schema-ownership gate entries, the route inventory baseline and manifest, regenerated maps (last step before pushing), and the frontend catalog if the capability response changes.

## 6. Risks and test plan

### 6.1 Risks

| Risk | Mitigation |
|---|---|
| Name index swap blocks the backfill if ordered wrongly | index swap is statement 1 of the migration; cold-replay test |
| Backfill assigns the wrong Project when a checklist is shared across Projects | deterministic order (Project `created_at`, then id); copies carry `legacy_checklist_id`; verification query in section 5 |
| Edits destroy Progress (legacy item replace deletes and reinserts) | edit by item id only; legacy replace refused for migrated rows |
| Strict staleness: any repository moving invalidates the sign-off for all | intended (the QA'd combination changed); the UI shows which repository moved and offers a new run, which snapshots again |
| Requirement edited after a sign-off | the gate does not change; `requirementsChanged` is informational and a lead can reopen. Making it blocking would invalidate sign-off on every typo fix |
| N GitHub reads per gate evaluation | parallel reads, the same call as today per repository; `Promise.all` with a per-repository failure reason |
| Developers lose Verification | intended; `item.canUpdate` replaced by `permissions.canSetVerification` |
| Silent undefined injection of the optional notification sink | explicit `@Inject(Class)` token and the boot test in `tests/architecture/http-boot.spec.ts` |
| Undecorated domain classes get no constructor args | new rule modules are plain functions |
| Deleting a Project leaves orphan requirements | `DELIVERY_PROJECT_DATA_CLEANUP` port; unassigned rows are never deleted by it |
| Notification deep link for a multi-repository run | uses the frontend repository, else the oldest (6.3 decision 5); revisit if the inbox needs a Project target |
| `npm run lint` covers `tests/`; a path-scoped eslint passed locally and failed in CI | run the full repository gate commands before pushing |

### 6.2 Test plan

- **Rules (unit):** every function in 4.1 over `admin|lead|qa|member`; `evaluateProjectPromotionGate` matrix: no run, open run, Rejected, Conditional, Approved and current, Approved and one repository moved, repository added after the run, head unreadable, no requirements, single-repository Project equals the old result, newest sign-off Rejected over an older Approved.
- **Migration (integration, real database, no mocks):** apply the whole tree to an empty database, then again (idempotent); seed 2 checklists, 4 items, 4 shares across 2 Projects plus 3 runs, assert the expected requirements, copies and untouched runs; re-run adds nothing; unshared checklist stays unassigned; archived Project and archived repository are skipped.
- **Repository SQL:** unique name index per scope; `scope_shape` check rejects mixed rows; fingerprint idempotency under concurrent create; Progress write with stale `row_version`; `returned_to_dev` resets Progress in the same transaction; order endpoint rejects a partial set.
- **Service:** Project run snapshot (items from several requirements, global positions, `prior_run_item_id`); sign-off rules unchanged; legacy run writes return `QA_RUN_LEGACY_READONLY`; notification fan-out per 4.2 and no self-notification.
- **Controller / HTTP boot:** guards, 404 for non-members, DTO validation; DI boot test for the new providers and the cleanup port.
- **Gate end to end:** two repositories, one Project: approve, merge A, move B, A blocked; re-run and approve, A and B eligible.
- **Docs and gates:** `npm run check:documentation`, `check:schema-ownership`, `check:capabilities`, route inventory, full `npm run lint`, and regenerate the maps as the last step.

### 6.3 Confirmed decisions (2026-10-01)

1. **Passed requires Done.** Setting Verification `passed` on a run item whose source item's Progress is not `done` is refused with 409 `QA_PROGRESS_NOT_DONE` ("A developer marks this Done before QA can pass it."). `failed`, `blocked`, `returned_to_dev` and `pending` stay allowed at any Progress. Run items whose source item was deleted (`source_item_id` null) cannot be passed either.
2. **Strict staleness.** Any repository of the Project moving its `uat` head, or a repository joining the Project, makes the latest signed-off run stale for every repository (section 3.1 unchanged).
3. **Unfiled repositories are blocked** (section 3.3 unchanged).
4. **Requirement edits are informational.** Editing, adding, archiving or reordering requirements after a sign-off does not change the gate. The run, the `current` endpoint and `GET .../qa/promotion` expose `requirementsChanged: true` and the UI shows "Requirements changed since sign-off"; a lead may reopen.
5. **Notification link goes to the frontend repository first.** `projectId` on a Project-run notification is the Project's repository with a `frontend` deployment target (`env_provisioning.project_deployment_targets.slot = 'frontend'`, read through a port owned by the runtime module, not a cross-schema query), oldest first; with none, the Project's oldest linked repository. This replaces the "oldest repository" rule in 4.2.

This file lives in `docs/design/`, which no index links. Existing specs live in `docs/superpowers/specs/`; move it there if the maintainers prefer one location.

## 7. Test cases under a User story (ADR-0014, amendment 10)

QA writes how a story is tested: categories of test cases ("Happy path", "Validation", "Session") under a User story, and the test cases inside them. A run records QA's result per test case.

### 7.1 Model

Migration `supabase/migrations/projects/20261020010000_qa_test_cases.sql` (additive; rollback `supabase/rollbacks/20261020010000_qa_test_cases_down.sql` fails closed while any row exists).

| Table | Holds | Key points |
|---|---|---|
| `qa_test_case_categories` | `item_id` (the story, cascade), `position`, `name` (1 to 120), `row_version` | unique `(item_id, lower(name))`; at most 30 per story |
| `qa_test_cases` | `category_id` (cascade), `position`, `title` (1 to 300), `expected_result` (max 2000), `row_version` | at most 100 per category |
| `qa_run_test_cases` | `run_id`, `run_item_id` (cascade), `source_test_case_id` / `source_category_id` (SET NULL), snapshot of category name and position, title, expected result, `status`, `notes`, verifier, `row_version` | unique `(run_item_id, source_test_case_id)` is the sync's upsert key; a verifier is set exactly when `status <> 'pending'` |

### 7.2 Rules

- **Who:** `canManageTestCases` (qa, admin) writes definitions; `canSetVerification` (qa, lead, admin) records results. Non-members of the group get 404.
- **Which items:** items of a `functional` requirement only (`409 TEST_CASES_STORY_ONLY`). Archived Features and delivered Iterations refuse writes.
- **Open runs follow the definitions.** `syncOpenRunTestCases(client, iterationId)` runs in the same transaction as every definition write, after `appendMissingItemsToOpenRuns`, and after a new run is created. It locks the open runs FOR SHARE, then the affected run items FOR UPDATE in id order, deletes copies whose definition is gone, upserts the rest (an unchanged copy is not rewritten; a result is never reset by an edit), and bumps `row_version` of every run item it changed. Signed-off runs are never touched.
- **Strict pass:** `passed` on a run item is refused while any of its test cases is `pending`, `failed` or `blocked` (`409 QA_TEST_CASES_OPEN` with `openTestCases`). `not_applicable` counts as resolved.
- **Sign-off:** `APPROVED` is refused while any test case of the run is open (same code), since one can be added or re-marked after its story passed. The merge-to-main gate is unchanged.
- **Pending, Passed, Failed only (amendment 11):** a test case result and a story's Verification are `pending`, `passed` or `failed`. A failed story goes back to the Developers exactly as `returned_to_dev` did (Progress `in_progress`, the "returned" bucket, re-queued to `pending` when a Developer marks it Done). `blocked`, `returned_to_dev` and `not_applicable` are no longer set; rows written before keep them.
- **Product owner acceptance (amendment 12):** after QA's `APPROVED` or `CONDITIONAL` sign-off, a Product owner or admin passes or fails each run item (`qa_run_items.po_status`, `po_by`, `po_by_login`, `po_at`; migration `20261021010000_qa_po_acceptance.sql`). Failing needs notes, reopens the run and fails the item, which returns the story to the Developers; QA and the Developers are notified (`qa.item.po_rejected`). A QA status write resets the item's acceptance. Merge to main waits until every item of the latest signed-off run is accepted. Test case results are recorded by QA and admins only (`403 TEST_CASE_RESULT_FORBIDDEN`).

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

Reads: `RequirementItem.testCategories` (always `[]` on system items), `permissions.canManageTestCases` on the requirement list, `ProjectQaRunItem.testCategories` (`[{ id | null, name, testCases: [{ id, sourceTestCaseId, position, title, expectedResult, status, notes, verifiedBy, verifiedAt, rowVersion }] }]`; an open run also lists categories with no test case yet) and `ProjectQaRunPermissions.canManageTestCases` (open run and qa or admin). The QA report (JSON, Markdown, Excel) carries the test cases; reports frozen before this have no `testCategories` key.
