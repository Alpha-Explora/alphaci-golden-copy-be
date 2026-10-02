# AlphaCI Enterprise: Persona Architecture, Branch Scoping & Notification Specification

## 1. Executive Summary

This document serves as the single source of truth for role boundaries, branch visibility, pull request routing, and notification fan-out within AlphaCI Enterprise.

The platform coordinates three distinct engineering personas around a single continuous delivery pipeline:
1. **Team Lead (Product Owner)**: Governance, requirement definition, workspace management, and production release gatekeeper.
2. **QA Team**: Independent quality assurance, manual & automated preview testing, defect reporting, and release certification.
3. **Developer**: Feature development, CI pipeline verification, defect remediation, and promotion to UAT.

---

## 2. Persona Role Definitions & Hierarchy

Authorization in AlphaCI is driven by the global `identity.app_users.app_role` column (synced from GitHub Organization teams):

| Persona | Wire `appRole` | UI Badge Label | GitHub Team Slug | Core Responsibilities |
| :--- | :--- | :--- | :--- | :--- |
| **Team Lead (Product Owner)** | `lead` (or `admin`: GitHub org owners and platform admins) | `Team lead` | `team-lead` | Creates Project Folders, attaches repositories, authors QA checklists, audits logs, manages team members, inspects UAT content in QA Studio, and **merges UAT to main (production)**. |
| **QA Team** | `qa` | `QA Team` | `qa-team` | Tests live preview deployments on `uat` inside QA Studio, executes automated Playwright suites, records defect severity, **returns defective items to developers**, and signs off builds. |
| **Developer** | `member` | `Developer` | `developers` | Builds features, pushes code to `dev`, opens promotion PRs from `dev` to `uat`, monitors CI stage runs, and resolves defects via the **"My QA items"** card on Project Overview. |

---

## 3. Feature Separation Matrix

| Feature Area | Specific Action | Team Lead (Product Owner) | QA Team | Developer | Enforcement Mechanism |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **Project Creation** | Create Project Folder | **Allowed** | Restricted | Restricted | `canCreateProjectFolder(appRole)` (lead, admin) in `HierarchyAccessService.assertCanCreateProjectInGroup` / `assertCanCreateUnderSystem`; refusal `403 PROJECT_CREATE_FORBIDDEN` |
| | Provision New Project / Stack (create a repository) | Restricted | Restricted | **Allowed, only into an existing Project of their team** | `canCreateRepository(appRole)` (member, admin) + `repositoryCreateRequiresProject` in `WorkspaceGateService.assertCanCreateRepositories`; lead/QA `403 REPOSITORY_CREATE_FORBIDDEN`, Developer without a Project `400 PROJECT_REQUIRED`; Developer into a Project with no active Feature (a `functional` requirement) `409 PROJECT_FEATURES_REQUIRED` (`repositoryCreateRequiresFeature`, before any GitHub call; skipped when `projects.qa-checklists` is off; also enforced on `POST /delivery-projects/:id/repositories` through `PROJECT_REQUIREMENTS_READINESS`). Admin unchanged (Project optional, exempt from the Feature rule). Covers `POST /projects`, `/projects/setup`, `/existing-repos/*`, `POST /github/repos` (admin only) |
| | Archive / Delete Project (incl. a Project folder with its repositories) | **Allowed** | Restricted | Restricted | `canManageProjectLifecycle(appRole)` in `ProjectLifecycleService.disconnectProject`; folder delete `DELETE /delivery-projects/:id` |
| **Repository Management** | Create Repository under Project | Restricted | Restricted | **Allowed** (member of the Project's team) | `canCreateRepository(appRole)` in `HierarchyAccessService.assertCanCreateUnderDeliveryProject` (`POST /delivery-projects/:id/repositories`) |
| | Move Repository between Folders | **Allowed** | Restricted | Restricted | `useMoveRepositoryViewModel` |
| **Project Requirements** | Create / Edit / Archive Requirements (Features with User stories, System requirements) | **Allowed** | Read-Only | Read-Only | `QaRequirementsService.assertManage` via `canManageRequirements(appRole)` (lead, admin; independent of repository creation); others `403 REQUIREMENT_MANAGE_FORBIDDEN`. Requirements belong to the Project and apply to every repository in it; there is no per-repository sharing. A Product owner can add up to 20 at once with `POST /delivery-projects/:id/requirements/batch` (all or nothing). One active Feature unlocks repository creation for Developers in that Project |
| | Set item Progress (`todo`, `in_progress`, `done`) | **Allowed** | Restricted | **Primary Role** | `canSetProgress(role)` (member, lead, admin) in `QaRequirementsService.setProgress`; QA `403 PROGRESS_FORBIDDEN`. `done` means ready for QA |
| **QA Studio (UAT)** | Access QA Studio (`#qa`) | **Allowed (UAT)** | **Allowed (Primary)** | Restricted (Hidden) | `QA_STUDIO_ROLES` (`['qa', 'lead', 'admin']`) |
| | Live Preview Canvas (Desktop/Tablet/Phone) | Can View & Test | Can View & Test | Restricted | `useStudioViewportViewModel` |
| | Trigger Playwright Tests | Can Trigger | Can Trigger | Restricted | `roleCanDispatch(appRole)` |
| **Verification Execution** | Start a Project run (once per Project, across every repository's `uat` head) | Can Execute | **Primary Role** | Restricted | `canCreateRun(role)` |
| | Mark Items (`Passed`, `Failed`, `Blocked`) | Can Execute | **Primary Role** (every item) | Restricted (reports Progress instead) | `canSetVerification(role)` (qa, lead, admin; developers `403 VERIFICATION_FORBIDDEN`), surfaced as `permissions.canSetVerification`. `Passed` needs the item's Progress to be `done` (`409 QA_PROGRESS_NOT_DONE`) |
| | Send Back to Dev (`Returned to dev`) | Can Execute | **Primary Role** | Restricted | `canSetReturnedToDev(role)` |
| | Sign Off Run (`Approved`, `Rejected`, `Conditional`) | Can Sign Off | **Primary Role** | Restricted | `canSignOff(role)` |
| | Export QA Report (PDF / Markdown) | Can Export | Can Export | Read-Only | `useQaExportViewModel` |
| **Developer Resolution** | View "My QA items" Card (Overview) | Read-Only | Can View (project-wide) | **Primary Role** (project-wide: every developer's items, not only the caller's) | `GET /delivery-projects/:id/qa/my-items` (`returned`, `inProgress`, `todo`, `readyForQa`) |
| | Mark an item `done` (re-queues a returned item for QA) | Can Submit | Restricted | **Primary Role** | `canSetProgress(role)`; the old `request-retest` route is an alias for Progress `done` |
| **Release Promotion** | View "Ready for Production" Gate | Can View | Can View | Read-Only | `promotion-card.tsx` |
| | **`Merge to main`** (Release to Production) | **Authorized (Sole)** | Restricted (Hidden) | Restricted (Hidden) | `canMergeQaPromotion(role)` (HTTP 403 for others); gate is per Project, see §5 |
| **CI/CD & Code** | CI Stage Stepper & Tool Logs (`Runs` Tab) | Summary View | Summary View | **Deep Debug View** | `runs-by-branch.ts` |
| | Create PR: `<own-branch> → dev` | Allowed | Restricted | **Primary Role** | `CreatePullRequestView` |
| | Create PR: `dev → uat` | Allowed | Restricted | **Primary Role** | `CreatePullRequestView` / Automated CI job |
| | Create PR: `feature → uat` (skipping dev) | Allowed | Restricted | Restricted | `isAllowedPullRequestRoute` → 403 `PR_ROUTE_RESTRICTED` for Developers (`member`); lead/admin unrestricted except main |
| | Create PR: `* → main` | Restricted | Restricted | Restricted | `canCreatePullRequest` → 403 `MAIN_PR_RESTRICTED` for every role; only the CI `promote-to-main` job opens `uat → main` |
| **Hosting & Secrets** | View Target URLs & Logs | Can View | Can View | Can View | `hosting-tab.tsx` |
| | Reinstall Deployment Secrets | **Authorized** | Restricted | Restricted | FE `canReinstallDeploymentSecrets(appRole)`; BE `canManageProjectLifecycle(appRole)` → 403 `PROJECT_ROLE_FORBIDDEN` |
| | Manage Deployment Targets & Custom Domains (add, change, verify, remove) | Restricted (read-only) | Restricted (read-only) | **Full Access** | `canManageHosting(appRole)` (admin \| member; unresolved role refused) → 403 `HOSTING_LEAD_ONLY` (legacy code kept for the deployed frontend; message is role-neutral) |
| | Manage Environment Variables | Restricted | Restricted | **Full Access** | `canManageEnvVars(appRole)` (admin \| member; unresolved role refused) → 403 `ENV_VARS_LEAD_ONLY` (legacy code kept, role-neutral message). Admins keep full access; Product owners and QA do not see the tab |
| **Audit** | View a repository's Audit tab | Can View | Can View | Can View | `GET /projects/:id/audit`: visible to everyone who can see the repository (`findByIdAndUser`), 404 otherwise; Project-level requirement events appear on every repository of the Project (`scope: 'project'`) |
| **Team Administration** | Manage Members & Workspace Roles | **Full Access** | Restricted | Restricted | `group-members.service.ts` |
| **Inbox & Notifications** | Receives "Project Created" Alert | **Yes** | Optional | **Yes** | `NotificationEventsService.record` |
| | Receives "Returned to Dev" Alert | Yes (Owner) | No (Sender) | **Yes** | `qa.item.returned_to_dev` |
| | Receives "Ready for QA" Alert (Progress set to `done`) | Read-Only | **Yes** | No (Sender) | `qa.item.retest_requested` |

---

## 4. Branch Visibility & Scoping Rules

To maintain high developer velocity while preventing visual noise and accidental branch tampering:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        BRANCH VISIBILITY MATRIX                        │
├────────────────────────────────────────────────────────────────────────┤
│  Persona     │ Visible Branches in UI Dropdowns                        │
├──────────────┼─────────────────────────────────────────────────────────┤
│  Developer   │ [dev], [uat] + [Own feature branches]                  │
│  QA Team     │ [dev], [uat], [main] (Canonical rungs only)             │
│  Team Lead   │ [All branches] (Full repository oversight)              │
│  Pipeline    │ [dev], [uat], [main] (Runs swimlane grouping)           │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Developers (`member`)**:
   - Filtered in `GET /projects/:projectId/workspace/branches`.
   - Returns the shared working branch (`dev`), `uat` (deliberate: Developers promote `dev → uat`, so they must see the target rung) and branches authored by that developer (`feature/<login>-*` or commit author match).
   - In-progress branches of peer developers are filtered out of individual selector dropdowns.

2. **QA Team (`qa`)**:
   - Filtered in `GET /projects/:projectId/workspace/branches`.
   - Returns strictly `dev`, `uat`, and `main`. QA is never exposed to personal developer feature branches.
   - QA Studio is locked to `uat` (`QA_BRANCH = 'uat'`).

3. **Team Lead (`lead` / `admin`)**:
   - Receives all branches across the entire repository to enable code reviews, auditing, and troubleshooting.

4. **Workflows & Runs Tab**:
   - Enforces `runs-by-branch.ts`: Groups workflow runs strictly by the three promotion rungs (`dev`, `uat`, `main`).
   - Feature branch runs and pull request merge refs (`refs/pull/*/merge`) are omitted from the main pipeline tab.

---

## 5. Pull Request & Promotion Pipeline

### Linear Promotion Flow
Code strictly flows forward:
`feature/*` → `dev` → `uat` → `main`

### Developer PR Rules
- **Hop 1 (Feature Integration)**:
  - `head`: Developer's feature branch (e.g. `feature/order-summary`)
  - `base`: **`dev`**
  - Triggered manually by developer. Merged once peer review and CI tests pass.
- **Hop 2 (Promotion to QA)**:
  - `head`: **`dev`**
  - `base`: **`uat`**
  - Auto-generated by CI (`promote-to-uat` job) upon successful `dev` build, or opened manually by developer.
  - Merged by developer or lead once CI tests pass. This `dev → uat` hop is the only route into `uat` open to a Developer: `feature → uat` and any PR out of `uat` are refused with 403 `PR_ROUTE_RESTRICTED` (open and merge; the merge reads the head from the PR). Lead and admin may open or merge any route except into `main`.
  - Merging triggers automated UAT deployment on Render / Vercel.
- **Hop 3 (Production Release Gate)**:
  - `head`: **`uat`**
  - `base`: **`main`**
  - **Nobody opens or merges this PR by hand.** The CI `promote-to-main` job opens it automatically after a `uat` build; `createPullRequest` refuses base `main` (403 `MAIN_PR_RESTRICTED`) and the generic merge endpoint refuses it (403 `MAIN_MERGE_VIA_QA_STUDIO`) for every role.
  - Controlled strictly inside QA Studio via the **"Ready for production"** card.
  - The **`Merge to main`** button becomes active **only when the Project's latest signed-off QA run is `APPROVED` and still current for every repository of the Project**: it captured the `uat` head of each repository, and each of those heads is still the head now. If any repository moves, or a repository joins the Project, the run is stale for all of them and QA runs again. A repository filed under no Project is blocked (`409 QA_PROJECT_REQUIRED`). Editing requirements after a sign-off does not block the merge; the card shows "Requirements changed since sign-off" and a lead may reopen.
  - Merged solely by **Team Lead** or **Admin**.

---

## 6. QA Defect Resolution: "Returned to Dev" Loop

```
                       QA Studio (uat)
                 QA selects "Returned to dev"
                             │
       ┌─────────────────────┴─────────────────────┐
       ▼                                           ▼
Defect Metadata Recorded                Notification Dispatched
- Severity: Blocker / Major / Minor     Event: qa.item.returned_to_dev
- Failure notes                         Sent to: Project Owner & Developers
- Reproduction steps                    Delivered to: /inbox + sidebar badge
                             │
                             ▼
                 Project Overview Tab
                 "My QA items" Card
                 - Developer inspects notes & repro steps
                 - Developer fixes code and pushes
                 - Sets the item's Progress to "done"
                             │
                             ▼
                 QA Re-tests in QA Studio
                 - Verifies fix on new UAT commit
                 - Marks item "Passed"
```

---

## 7. Project Creation Notification Fan-Out

### The Requirement:
When a Team Lead / Product Owner provisions a project under a Workspace/Team, a notification must be dispatched to:
1. All **Team Leads** (`app_role = 'lead'`) of that workspace.
2. All **Developers** (`app_role = 'member'`) of that workspace.

### Technical Implementation Blueprint:

#### Step 1: Database Query (`ProjectsRepository`)
```ts
async listWorkspaceLeadAndDeveloperIds(workspaceId: string): Promise<string[]> {
  const result = await this.databaseService.query<{ id: string }>(
    `
      SELECT DISTINCT u.id
      FROM orgs.workspace_members m
      JOIN identity.app_users u ON u.id = m.user_id
      WHERE m.workspace_id = $1
        AND m.member_status = 'active'
        AND u.app_role IN ('lead', 'member');
    `,
    [workspaceId],
  );
  return result.rows.map((row) => row.id);
}
```

#### Step 2: Fan-Out Notification Helper (`ProjectProvisioningSupport`)
```ts
async notifyProjectCreated(input: {
  workspaceId: string;
  creatorUserId: string;
  creatorLogin: string;
  projectId: string;
  repoFullName: string;
  repoShape: string;
}): Promise<void> {
  const notifications = this.notificationEventPublisher;
  if (!notifications || !input.workspaceId) return;

  const recipientIds = await this.projectsRepository.listWorkspaceLeadAndDeveloperIds(input.workspaceId);
  const deduplicated = [...new Set(recipientIds)];

  await Promise.all(
    deduplicated.map((userId) =>
      notifications.record({
        userId,
        projectId: input.projectId,
        eventCode: 'project_created',
        title: `New project created: ${input.repoFullName}`,
        body: `@${input.creatorLogin} created project ${input.repoFullName}. It is now tracked and ready for development.`,
      }),
    ),
  );
}
```

#### Step 3: Wire into All Provisioning Shapes:
- `single-repository-project.provisioner.ts` (Single repo creation and setup)
- `multi-repository-project.provisioner.ts` (Full-stack paired `-fe` and `-be` repos)
- `microservices-project.provisioner.ts` (Service mesh provisioner)

---

## 8. Additional Recommended Implementations

Based on comprehensive inspection of the current codebase, the following 7 enhancements are recommended:

### 1. Backend PR Route Enforcement (`project-workspace.service.ts`)
- **Status**: Implemented (Phase 1). Per §3 this applies to every role, not only `member`: base `main` → 403 `MAIN_PR_RESTRICTED`; `qa` may not open or merge pull requests at all → 403 `PR_ROLE_FORBIDDEN`. The generic merge endpoint also refuses base `main` (403 `MAIN_MERGE_VIA_QA_STUDIO`), so QA Studio's gate is the only path to production. Developers (`member`) are further limited to routes `<non-pipeline branch> → dev` and `dev → uat`, for both open and merge: any other route → 403 `{ code: 'PR_ROUTE_RESTRICTED', message: 'Developers open pull requests from a feature branch into dev, and from dev into uat.' }` (base `main` keeps `MAIN_*` precedence; qa keeps `PR_ROLE_FORBIDDEN`). The workflow-update PR (head `alphaci/workflow-update-*`) therefore passes for a Developer only when `dev` exists; a repo with only `uat` is refused with `PROJECT_ROLE_FORBIDDEN`. Rules (`isAllowedPullRequestRoute`) live in `src/kernel/rules/persona-access.rules.ts` (BE) and mirror FE `canCreatePullRequest` / `canMergeViaWorkspace`.

### 2. Role-Gated Branch Listing API (`project-workspace.service.ts`)
- **Current State**: `listBranches` returns all GitHub branches unfiltered.
- **Improvement**:
  - `role === 'qa'`: Filter to `['dev', 'uat', 'main']`.
  - `role === 'member'`: Filter to `['dev']` + branches where branch name matches `feature/<login>-*` or author login matches user.
  - `role === 'lead'`: Return all branches.

### 3. Developer Defect Notification Recipient Targeting (`qa-runs.service.ts`)
- **Current State**: `ownerAndLeadRecipients` notifies `project.user_id` and leads on `returned_to_dev`.
- **Improvement**: Explicitly include the developer who authored the commit under test on UAT, ensuring the engineer who wrote the bug receives the alert directly.

### 4. PR Preset Mode Selector in Frontend UI (`create-pull-request-view.tsx`)
- **Current State**: Generic base/head dropdowns.
- **Improvement**: Add radio/pill presets for developers:
  - `[Feature → Dev]` (Auto-fills `base: dev`)
  - `[Dev → UAT]` (Auto-fills `head: dev, base: uat`)
  - Disables manual selection of `main`.

### 5. Multi-Repo Promotion PR Pairing (`multi-repository-project.steps.ts`)
- **Current State**: Promotion PRs run per repository.
- **Improvement**: When promoting full-stack project folders (`testfinals`), cross-link the frontend and backend promotion PRs in the PR body so both services deploy in lockstep.

### 6. Notification Center Deep-Links (`notifications-inbox-view.tsx`)
- **Current State**: Clicking a notification opens the project overview.
- **Improvement**:
  - `qa.item.returned_to_dev` → deep-links to `/projects/[id]#overview` with the "My QA items" card highlighted.
  - `project_created` → deep-links directly into the project folder.
  - `qa.run.signed_off` → deep-links to `/projects/[id]#qa`.

### 7. Branch Protection Verification Probe (`project-provisioning.support.ts`)
- **Current State**: Branch protection rules are configured during provisioning.
- **Improvement**: Add a drift probe verifying that `dev` remains pushable while `uat` and `main` remain protected against direct pushes and deletions.

---

## 9. Implementation Status (2026-10-01)

Authority for persona gates is the global `identity.app_users.app_role` (platform admins resolve to `admin`), always as an allow-list. Workspace scoping is still required: the user must be the project owner, an active member of its workspace, or assigned to one of its repositories.

| Phase | Scope | Status |
|---|---|---|
| 0 | Delete a Project folder with its repositories (BE #127, FE #70); ghost repositories removed and `provisioned_project_id` cascades on delete | Done |
| 1 | Merge into `main` only via QA Studio; no manual PRs into `main`; QA cannot open/merge PRs; env vars, reinstall secrets and disconnect on `app_role` lead/admin | Done |
| 2 | §7 project-created fan-out; §6 returned-to-dev reaches developers, re-test reaches QA; §8.6 notification deep-links | Done |
| 3 | §4 / §8.2 role-filtered branch list; §8.4 PR presets; Runs tab summary vs deep debug | Done |
| 7 | Persona-audit backend fixes: `GET /ci/runs` scoped by project visibility plus optional `workspaceId` (was project-owner only); `GET /workspaces/me` lists active memberships only with the role derived from `app_role`; `/auth/me` `appRole` folds platform admins into `admin`; workspace membership lookups ignore removed members | Done |
| 4 | §8.5 FE/BE promotion PR pairing (real location: `staged-workflow.builder.ts` + `alphaci-workflow/.github/workflows/promotion.yml`); §8.7 branch-protection drift probe (protection is applied in the provisioners) | Not started |

Known code-vs-spec gaps still open (spec is the intended behaviour):
- §3 "Ready for Production" card: rendered only inside QA Studio, which Developers cannot open; spec says Developers can view it.
- GitHub branch protection uses `restrictions: null`, so a user with write access can still merge `uat → main` directly on github.com; ALPHACI itself no longer offers that path.
