# AlphaCI: Persona Architecture, Branch Scoping & Notification Specification

## 1. Summary

This document is the reference for role boundaries, branch visibility, pull request routing and notification fan-out. Backend rules live in `src/kernel/rules/persona-access.rules.ts` and `src/modules/projects/domain/qa-run-access.rules.ts`; the frontend mirrors them. QA requirements, runs and the merge gate are specified in `docs/design/project-requirements.md` and ADR-0014.

Three personas share one delivery pipeline:
1. **Product owner (Team lead)**: requirements, Projects, acceptance of QA's result, and the production release.
2. **QA Team**: test cases, verification of the `uat` build, defect reporting and sign-off.
3. **Developer**: repositories, branches, Progress on stories, and fixes for what QA fails.

---

## 2. Persona Role Definitions

Authorization uses the global `identity.app_users.app_role` column, synced from GitHub organization teams (`GITHUB_TEAM_LEAD_SLUG`, `GITHUB_TEAM_QA_SLUG`, `GITHUB_TEAM_DEVELOPER_SLUG`; precedence lead > qa > developer). Platform admins and GitHub org owners resolve to `admin`. Every check is an allow-list. Workspace scoping still applies: the user must be the repository owner, an active member of its workspace, or assigned to one of its repositories.

| Persona | Wire `appRole` | UI Badge Label | GitHub Team Slug | Core Responsibilities |
| :--- | :--- | :--- | :--- | :--- |
| **Product owner (Team lead)** | `lead` (or `admin`) | `Team lead` | `team-lead` | Creates Projects, writes requirements (Features with User stories, system requirements), manages team members, accepts a signed-off QA run item by item in PO Studio, merges `uat` to `main`, and starts the next Iteration. |
| **QA Team** | `qa` | `QA Team` | `qa-team` | Writes test cases under User stories, tests the `uat` build in QA Studio, records test case results, marks items Pending, Passed or Failed with a severity, runs Playwright, and signs runs off. |
| **Developer** | `member` | `Developer` | `developers` | Creates repositories in a Project that has a Feature, creates branches from `dev`, opens pull requests into `dev` and from `dev` into `uat`, sets Progress on stories, fixes failed stories from "My QA items", and manages hosting and environment variables. |

---

## 3. Feature Separation Matrix

| Feature Area | Specific Action | Product owner (Team lead) | QA Team | Developer | Enforcement Mechanism |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **Project Creation** | Create Project Folder | **Allowed** | Restricted | Restricted | `canCreateProjectFolder(appRole)` (lead, admin) in `HierarchyAccessService.assertCanCreateProjectInGroup` / `assertCanCreateUnderSystem`; refusal `403 PROJECT_CREATE_FORBIDDEN` |
| | Provision New Project / Stack (create a repository) | Restricted | Restricted | **Allowed, only into an existing Project of their team** | `canCreateRepository(appRole)` (member, admin) + `repositoryCreateRequiresProject` in `WorkspaceGateService.assertCanCreateRepositories`; lead/QA `403 REPOSITORY_CREATE_FORBIDDEN`, Developer without a Project `400 PROJECT_REQUIRED`; Developer into a Project with no active Feature in its current Iteration `409 PROJECT_FEATURES_REQUIRED` (`repositoryCreateRequiresFeature`, before any GitHub call; skipped when `projects.qa-checklists` is off; also enforced on `POST /delivery-projects/:id/repositories` through `PROJECT_REQUIREMENTS_READINESS`). Admin: Project optional, exempt from the Feature rule. Covers `POST /projects`, `/projects/setup`, `/existing-repos/*`, `POST /github/repos` |
| | Archive / Delete Project (incl. a Project folder with its repositories) | **Allowed** | Restricted | Restricted | `canManageProjectLifecycle(appRole)` (lead, admin) in `ProjectLifecycleService.disconnectProject`; folder archive and `DELETE /delivery-projects/:id` through `HierarchyAccessService.assertDeliveryProjectManager` |
| **Repository Management** | Create Repository under Project | Restricted | Restricted | **Allowed** (member of the Project's team) | `canCreateRepository(appRole)` in `HierarchyAccessService.assertCanCreateUnderDeliveryProject` (`POST /delivery-projects/:id/repositories`) |
| | Move Repository between Folders | **Allowed** | Restricted | Restricted | BE `assertRepositoryManagerOrPlatformAdmin`; FE `useMoveRepositoryViewModel` |
| | Repository assignment (GitHub team sync) | n/a | n/a | **Only Developers can be assigned** | `canBeAssignedRepository(targetRole)` (member) |
| **Project Requirements** | Create / Edit / Archive Requirements (Features with User stories, System requirements) | **Allowed** | Read-Only | Read-Only | `canManageRequirements(appRole)` (lead, admin); others `403 REQUIREMENT_MANAGE_FORBIDDEN`. Requirements belong to the Project's current Iteration and apply to every repository in it. Up to 20 at once with `POST /delivery-projects/:id/requirements/batch` (all or nothing). One active Feature unlocks repository creation for Developers |
| | Set item Progress (`todo`, `in_progress`, `done`) | **Allowed** | Restricted | **Primary Role** | `canSetProgress(role)` (member, lead, admin); QA `403 PROGRESS_FORBIDDEN`. `done` means ready for QA |
| | Start the next Iteration | **Allowed** | Restricted | Restricted | `QaAccessService.canManage` (lead, admin); `403 ITERATION_START_FORBIDDEN`; only after the current Iteration is delivered (`409 ITERATION_ACTIVE`) |
| **Studios** | QA Studio (`#qa`, locked to `uat`) | Restricted | **Primary Role** | Restricted | FE `QA_STUDIO_ROLES` (`qa`, `admin`) |
| | PO Studio (`#po`, acceptance and Merge to main) | **Primary Role** | Restricted | Restricted | FE `PO_STUDIO_ROLES` (`lead`, `admin`) |
| | Trigger Playwright Tests | Can Trigger | Can Trigger | Restricted | BE `canDispatchAutomation(role)` (qa, lead, admin); FE `roleCanDispatch(appRole)` |
| **Verification Execution** | Start a Project run (once per Iteration and set of `uat` heads, across every repository) | Can Execute | **Primary Role** | Restricted | `canCreateRun(role)` (qa, lead, admin) |
| | Write Test Cases (categories and test cases under a User story) | Read-Only | **Primary Role** | Read-Only | `canManageTestCases(role)` (qa, admin; others `403 TEST_CASE_MANAGE_FORBIDDEN`) in `QaTestCasesService`, surfaced as `permissions.canManageTestCases` on the requirement list and on an open run. User stories of a Feature only (`409 TEST_CASES_STORY_ONLY`) |
| | Mark Items (`Pending`, `Passed`, `Failed`) | Can Execute | **Primary Role** | Restricted (reports Progress instead) | `canSetVerification(role)` (qa, lead, admin; developers `403 VERIFICATION_FORBIDDEN`), surfaced as `permissions.canSetVerification`. `Passed` needs Progress `done` (`409 QA_PROGRESS_NOT_DONE`) and every test case of the story passed (`409 QA_TEST_CASES_OPEN`). `Failed` needs a severity and sends the story back to the Developers (Progress `in_progress`). Other statuses answer `400 QA_VERIFICATION_STATUS_INVALID` |
| | Record Test Case Results (`Pending`, `Passed`, `Failed`) | Read-Only | **Primary Role** | Restricted | `canRecordTestCaseResults(role)` (qa, admin; others `403 TEST_CASE_RESULT_FORBIDDEN`), surfaced as `permissions.canRecordTestCases` |
| | Attach screenshot evidence | Can Attach | **Primary Role** | Restricted | `canAddEvidence(role)` (qa, lead, admin); deleting someone else's: `canRemoveAnyAttachment` (lead, admin) |
| | Sign Off Run (`Approved`, `Rejected`, `Conditional`) | Can Sign Off | **Primary Role** | Restricted | `canSignOff(role)` (qa, lead, admin). Refused while any item is failed (`409 QA_RUN_OPEN_DEFECTS`). `Approved` needs every item and test case passed and every item of the Iteration in the run (`409 QA_RUN_MISSING_ITEMS`) |
| | Reopen a signed-off run | **Allowed** | Restricted | Restricted | `canReopenRun(role)` (lead, admin) |
| | Accept a signed-off run, item by item (`Passed`, `Failed`) | **Primary Role** | Restricted | Restricted | `canAcceptRunItems(role)` (lead, admin), surfaced as `permissions.canAccept` on a run signed off `APPROVED` or `CONDITIONAL`. `Failed` needs notes, reopens the run and returns the story to the Developers; QA and the Developers are notified (`qa.item.po_rejected`). Merge to main waits for every item |
| | Export QA Report (JSON / Markdown / Excel; PDF is a browser print) | Can Export | Can Export | Can Export | BE serves `GET .../qa-runs/:runId/report` to any group member; FE `useQaExportViewModel` |
| **Developer Resolution** | View "My QA items" (project-wide: every developer's items) | Read-Only | Can View | **Primary Role** | `GET /delivery-projects/:id/qa/my-items` (`returned`, `inProgress`, `todo`, `readyForQa`) |
| | Mark an item `done` (re-queues a failed item for QA) | Can Submit | Restricted | **Primary Role** | `canSetProgress(role)`; the legacy `request-retest` route is an alias for Progress `done` |
| **Release Promotion** | View the "Ready for production" gate | Can View | Can View | Can View (API) | `GET /projects/:id/qa/promotion`, readable by anyone who can see the repository; the card is shown in the studios |
| | **`Merge to main`** (Release to Production), one repository or all | **Authorized** (with admins) | Restricted (Hidden) | Restricted (Hidden) | `canMergeQaPromotion(role)` (lead, admin; 403 for others) on `POST /projects/:id/qa/promotion/merge` and `POST /delivery-projects/:id/promotion/merge-all`; gate is per Project, see §5 |
| **CI/CD & Code** | CI Stage Stepper & Tool Logs (`Runs` Tab) | Summary View | Summary View | **Deep Debug View** | FE `runs-by-branch.ts` |
| | Browse branches and commits | All branches | `dev`, `uat`, `main` | All branches | `visibleBranchesFor(role, branches)`, see §4 |
| | Create a branch from `dev` | Allowed | Restricted | **Primary Role** | `canCreateWorkspaceBranch(role)` (admin, lead, member); QA `403 BRANCH_CREATION_FORBIDDEN` |
| | Create PR: `<feature-branch> → dev` | Allowed | Restricted | **Primary Role** | `isAllowedPullRequestRoute`; FE `CreatePullRequestView` |
| | Create PR: `dev → uat` | Allowed | Restricted | **Primary Role** | `isAllowedPullRequestRoute`; also opened by the CI `promote-to-uat` job |
| | Create PR: `feature → uat` (skipping dev) | Allowed | Restricted | Restricted | `isAllowedPullRequestRoute` → 403 `PR_ROUTE_RESTRICTED` for Developers; lead/admin unrestricted except `main` |
| | Create PR: `* → main` | Restricted | Restricted | Restricted | `canCreatePullRequest` → 403 `MAIN_PR_RESTRICTED` for every role; only the CI `promote-to-main` job opens `uat → main` |
| | Add browser tests (pull request into `dev`) | Allowed | Restricted | Allowed | `canAddBrowserTests(role)` (admin, lead, member) |
| **Hosting & Secrets** | View Target URLs & Logs | Can View | Can View | Can View | FE `hosting-tab.tsx` |
| | Reinstall Deployment Secrets | Restricted | Restricted | **Authorized** | BE `canManageHosting(appRole)` (admin, member; unresolved role refused) → 403 `PROJECT_ROLE_FORBIDDEN`; FE `canReinstallDeploymentSecrets(appRole)` |
| | Roll back a deployment | Restricted | Restricted | **Authorized** | `canManageHosting(appRole)` → 403 `PROJECT_ROLE_FORBIDDEN`; a reason is required and recorded in the Audit trail |
| | Manage Deployment Targets & Custom Domains (add, change, verify, remove) | Restricted (read-only) | Restricted (read-only) | **Full Access** | `canManageHosting(appRole)` → 403 `HOSTING_LEAD_ONLY` (legacy code kept for the deployed frontend; message is role-neutral) |
| | Manage Environment Variables | Restricted | Restricted | **Full Access** | `canManageEnvVars(appRole)` (admin, member) → 403 `ENV_VARS_LEAD_ONLY` (legacy code, role-neutral message). Product owners and QA do not see the tab |
| **Drift repair** | Mark ignored, rotate CI token, detach target, repair CI API URL, repair branch protection | **Allowed** | Restricted | Restricted | `canManageProjectLifecycle` / `canRepairBranchProtection` (lead, admin) → 403 `PROJECT_ROLE_FORBIDDEN` |
| | Regenerate workflow preview, open workflow update PR | Allowed | Restricted | Allowed | `canCreatePullRequest(role, dev, …)` |
| **Audit** | View a repository's Audit tab, force a GitHub sync | Can View | Can View | Can View | `GET /projects/:id/audit` and `POST /projects/:id/audit/sync`: anyone who can see the repository (`findByIdAndUser`), 404 otherwise; Project-level requirement events appear on every repository of the Project (`scope: 'project'`) |
| **Team Administration** | Manage Members & Workspace Roles | **Full Access** | Restricted | Restricted | `group-members.service.ts` (`assertGroupManagerOrPlatformAdmin`) |
| **Inbox & Notifications** | "Project created" | **Yes** | No | **Yes** | `project_created` |
| | "QA failed" (story returned to the Developers) | Yes | No (Sender) | **Yes** | `qa.item.failed`: repository owner, workspace leads, every Developer |
| | "Ready for QA" (Progress set to `done`) | No | **Yes** | No (Sender) | `qa.item.retest_requested`: workspace QA and the previous verifier |
| | "QA run signed off" | **Yes** | No (Sender) | No | `qa.run.signed_off`: run creator, repository owner, workspace leads |
| | "Product owner rejected" | No (Sender) | **Yes** | **Yes** | `qa.item.po_rejected`: run creator, signer, repository owner, workspace QA, leads, Developers |
| | "Iteration started" / "Iteration delivered" | Yes | Yes | Yes | `qa.iteration.started`, `qa.iteration.delivered` |
| | "Merged to main" | **Yes** | No | No | `qa.promotion.merged`: workspace leads |

The actor never receives their own notification.

---

## 4. Branch Visibility & Scoping Rules

```
┌────────────────────────────────────────────────────────────────────────┐
│                        BRANCH VISIBILITY MATRIX                        │
├────────────────────────────────────────────────────────────────────────┤
│  Persona     │ Visible Branches in UI Dropdowns                        │
├──────────────┼─────────────────────────────────────────────────────────┤
│  Developer   │ [All branches] (read-only source browsing)              │
│  QA Team     │ [dev], [uat], [main] (pipeline rungs only)              │
│  Team Lead   │ [All branches]                                          │
│  Pipeline    │ [dev], [uat], [main] (Runs swimlane grouping)           │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Developers (`member`)** and **Product owners / admins (`lead`, `admin`)**:
   - `GET /projects/:projectId/workspace/branches` and the Commits list (`GET /projects/:id/commits`) return every branch. Visibility is a listing filter only; it grants no write.
   - The branch response carries `canCreateBranch`. `POST /projects/:projectId/workspace/branches` with `{ branchName }` creates the branch from `dev`; the source is never chosen by the client. 400 when the repository has no `dev`, 409 when the branch exists. The creation is recorded as `repository_branch_created`.

2. **QA Team (`qa`)**:
   - Sees only `dev`, `uat` and `main` that exist, in both lists. QA cannot create branches (`403 BRANCH_CREATION_FORBIDDEN`).
   - QA Studio is locked to `uat` (`QA_BRANCH`).

3. **Any other role** sees `dev` only.

4. **Workflows & Runs Tab** (frontend): `runs-by-branch.ts` groups workflow runs by the three promotion rungs (`dev`, `uat`, `main`). Feature branch runs and pull request merge refs (`refs/pull/*/merge`) are omitted from the main pipeline tab.

---

## 5. Pull Request & Promotion Pipeline

### Linear Promotion Flow
Code flows forward: feature branch → `dev` → `uat` → `main`. Nobody pushes to `dev`, `uat` or `main` directly (see "Branch protection" below).

### Pull Request Rules
- **Hop 1 (Feature Integration)**:
  - `head`: a feature branch, usually created from `dev` in ALPHACI
  - `base`: **`dev`**
  - Opened by the developer.
- **Hop 2 (Promotion to QA)**:
  - `head`: **`dev`**
  - `base`: **`uat`**
  - Opened by the CI `promote-to-uat` job after a successful `dev` build, or by a developer.
  - Merged by a developer, lead or admin. This `dev → uat` hop is the only route into `uat` open to a Developer: `feature → uat` and any PR out of `uat` are refused with 403 `PR_ROUTE_RESTRICTED` (open and merge; the merge reads the head from the PR). Lead and admin may open or merge any route except into `main`.
  - Merging deploys `uat`.
- **Hop 3 (Production Release Gate)**:
  - `head`: **`uat`**
  - `base`: **`main`**
  - **Nobody opens or merges this PR by hand.** The CI `promote-to-main` job opens it after a `uat` build; `createPullRequest` refuses base `main` (403 `MAIN_PR_RESTRICTED`) and the generic merge endpoint refuses it (403 `MAIN_MERGE_VIA_QA_STUDIO`) for every role.
  - Merged only through the "Ready for production" gate, by a Product owner or admin: one repository (`POST /projects/:id/qa/promotion/merge`) or every covered repository at once (`POST /delivery-projects/:id/promotion/merge-all`).
  - The gate opens only when the latest signed-off QA run of the Project's current Iteration is `APPROVED`, captured the `uat` head of every repository and each head is unchanged, passed every item of the Iteration, predates every requirement change, and every item is accepted by the Product owner. If any repository moves, or joins the Project, the run is stale for all of them. A repository filed under no Project is blocked (`409 QA_PROJECT_REQUIRED`). When every covered repository is in `main`, the Iteration is delivered and the next one can start.

---

## 6. QA Defect Resolution Loop

```
                       QA Studio (uat)
             QA marks a story "Failed" (severity required)
                             │
       ┌─────────────────────┴─────────────────────┐
       ▼                                           ▼
Defect Metadata Recorded                Notification Dispatched
- Severity: Blocker / Major / Minor     Event: qa.item.failed
- Failure notes                         Sent to: Repository owner, leads,
- Reproduction steps                             every Developer
- Story Progress back to in_progress    Delivered to: /inbox + sidebar badge
- Sign-off held while it is open
                             │
                             ▼
                 "My QA items": returned
                 - Developer reads notes & repro steps
                 - Developer fixes the code through pull requests
                 - Sets the story's Progress to "done"
                   (run item back to Pending, severity cleared,
                    QA notified: qa.item.retest_requested)
                             │
                             ▼
                 QA re-tests in QA Studio
                 - Verifies the fix on the new uat build
                 - Marks the story "Passed"
```

A Product owner who fails an item after sign-off starts the same loop: the run reopens and the story is Failed with the Product owner's notes.

---

## 7. Project Creation Notification Fan-Out

When a repository is provisioned in a workspace, `ProjectProvisioningSupport.notifyProjectCreated` sends `project_created` ("New project created: <repo>") to every active workspace member whose `app_role` is `lead` or `member` (`ProjectsRepository.listWorkspaceLeadAndDeveloperIds`), deduplicated. Every provisioning shape calls it: single repository, multi-repository and multi-service.

---

## 8. Enforcement Details

### 1. Backend PR Route Enforcement (`project-workspace.service.ts`)
Applies to every role. Base `main` → 403 `MAIN_PR_RESTRICTED`; `qa` may not open or merge pull requests at all → 403 `PR_ROLE_FORBIDDEN`. The generic merge endpoint also refuses base `main` (403 `MAIN_MERGE_VIA_QA_STUDIO`), so the Merge to main gate is the only path to production. Developers (`member`) are limited to `<non-pipeline branch> → dev` and `dev → uat`, for both open and merge: any other route → 403 `{ code: 'PR_ROUTE_RESTRICTED', message: 'Developers open pull requests from a feature branch into dev, and from dev into uat.' }` (base `main` keeps `MAIN_*` precedence; qa keeps `PR_ROLE_FORBIDDEN`). Self-service ALPHACI pull requests (workflow settings, drift repair, existing-repo setup) target `dev`, else `uat`, never `main`; a repository with neither is refused. Rules (`isAllowedPullRequestRoute`) live in `src/kernel/rules/persona-access.rules.ts` and mirror FE `canCreatePullRequest` / `canMergeViaWorkspace`.

### 2. Role-Gated Branch Listing (`project-workspace.service.ts`)
`visibleBranchesFor(role, branches)`: `qa` gets `dev`, `uat` and `main`; `member`, `lead` and `admin` get every branch; anything else gets `dev`. The default branch is picked from the full list. See §4.

### 3. Failed Item Recipients (`qa-project-runs.service.ts`)
A failed story notifies the repository owner, the workspace leads and every Developer of the workspace. A Project run covers several repositories, so recipients are not narrowed to the author of one commit.

### 4. PR Presets in the Frontend (`pull-request-compose-rules.ts`)
Developers get presets `feature-to-dev` and `dev-to-uat`, plus `custom`; `main` is never offered.

### 5. Multi-Repo Promotion PR Pairing
Multi-repository projects pass the paired repository as the `sibling-repo` input of the generated `promote-to-uat` and `promote-to-main` jobs (`staged-workflow.builder.ts`), and `alphaci-workflow/.github/workflows/promotion.yml` cross-links the two promotion pull requests.

### 6. Notification Deep Links (frontend)
Notification deep links point the viewer at their own studio (`studioTabFor`: QA Studio for QA and admins, PO Studio for Product owners); a Developer has no studio.

### 7. Branch Protection Drift
The drift scan (`project-drift.service.ts`) reads protection on `dev`, `uat` and `main` and records `branch_protection_missing` (no pull request required), `branch_force_push_allowed` and `branch_deletion_allowed`. The `repair_branch_protection` action re-applies the rule (lead, admin).

### Branch protection
- Nobody pushes to `dev`, `uat` or `main`. Developers open pull requests from feature branches into `dev` and from `dev` into `uat`; `main` is reached only through Merge to main.
- GitHub rule on all three branches (`PROTECTED_BRANCHES`): pull request required with **zero** approvals (so ALPHACI-driven merges keep working), force pushes and deletion blocked, `enforce_admins` off for a new rule so an organisation admin keeps an escape hatch. Existing required status checks, restrictions and stricter settings are carried over, never overwritten.
- Applied at the end of provisioning (best effort) and to existing repositories by the admin-only `POST /projects/:id/branch-protection` and `POST /admin/branch-protection/apply`. The GitHub App needs Administration: write. See ADR-0015.

---

## 9. Known Gaps

- A new protection rule sets no push `restrictions`, so a user with write access can still merge a `uat → main` pull request directly on github.com. ALPHACI itself offers no such path.
