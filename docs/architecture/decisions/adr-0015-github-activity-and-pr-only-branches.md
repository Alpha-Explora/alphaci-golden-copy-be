---
type: "Decision"
title: "GitHub activity ingest and pull-request-only branches"
description: "dev, uat and main require a pull request, and each repository's GitHub activity is polled from the Events API into the Audit trail because webhooks do not reach the backend."
tags: [architecture, decision, github, audit, branch-protection]
status: stable
timestamp: "2026-10-02T00:00:00Z"
sources:
  - id: provider-boundaries
    resource: "/architecture/decisions/adr-0004-provider-and-port-boundaries.md"
    title: "Provider and port boundaries"
  - id: persona-workflow
    resource: "/architecture/current-architecture.md"
    title: "Current architecture"
---
# ADR-0015: GitHub activity ingest and pull-request-only branches

**Decision date:** 2026-10-02
**Decision status:** Accepted
**Scope:** branch protection on dev, uat and main; the Commits list; GitHub activity in the repository Audit trail

## Context

Developers pushed commits straight to `dev` because `dev` was deliberately unprotected. The repositories had zero merged pull requests, so the Pull requests "Closed" list was empty and no commit appeared anywhere in the product. The GitHub App also had zero installation rows and zero recorded webhook deliveries, so nothing is pushed to the backend.

## Decisions

1. **Every tier requires a pull request.** `PROTECTED_BRANCHES` is now all of `dev`, `uat`, `main`. The rule is: pull request required with zero approvals (ALPHACI merges on a person's behalf), force pushes and deletion blocked, `enforce_admins` off for a new rule (an organisation admin keeps an escape hatch). The rule is merged into what a branch already has (required status checks with their apps, restrictions, a stricter approval count, code-owner review, admin enforcement and the other switches are carried over); the PUT endpoint replaces the whole rule, so it is built from the current one. Retrofitting does not seed the env-guard check, because an older repository may lack the workflow and a required check that never reports blocks every merge; provisioning seeds it.
2. **Direct pushes by our own pipeline were checked.** The reusable workflows at `alphaci-workflow@v1` only open and edit pull requests (`promotion.yml`, with `PR_TOKEN`), comment on pull requests, and push tags in the central repository itself; none pushes to a customer branch. The one exception is the generated env-guard workflow, which pushes a rollback commit (`git push origin HEAD:$GUARD_BRANCH`) on push events; it already degrades to a warning when the push is rejected, and with pull requests required an environment file can only arrive through a pull request, where the required `env-guard` check blocks the merge. No change was needed. Initial "ci: add ALPHACI workflow" commits happen before protection is applied.
3. **Applied last, best effort.** Single, multi-repo, packed-repository and existing-repo setup apply protection after every initial commit. A failure logs a warning and records `project_branch_protection_failed`; success records `project_branch_protection_applied`; provisioning never fails because of it. Existing repositories are retrofitted by the admin-only `POST /projects/:id/branch-protection` and `POST /admin/branch-protection/apply`, which are idempotent.
4. **Polling, not webhooks.** The Events API (last 90 days, up to 300 events, ETag) is read per repository on the first Audit page, at most once a minute. The last successful sync (time and ETag) is stored in `audit.github_event_syncs`, owned by platform-ops, so the throttle holds across instances. The page waits at most 3 s for GitHub and otherwise returns stored events with `githubSync.status` `stale` (the run finishes in the background) or `failed`. In-memory state is limited to coalescing concurrent runs and a one-minute failure back-off; both are lost on restart at the cost of one extra conditional request.
5. **Dedupe by a nullable unique `audit.audit_events.external_id`** (`github:<event id>`), inserted `ON CONFLICT DO NOTHING`. The projects module maps repository to project and calls GitHub; the audit module owns the table and receives events through `AUDIT_EXTERNAL_INGEST_PORT`. The actor login is resolved to an ALPHACI user inside the insert; no match leaves `actor_user_id` NULL.
6. **GitHub no longer sends enough in the event.** `PushEvent` carries only `ref`, `before`, `head` (no commit list or size) and `PullRequestEvent` carries no title. For events not stored yet, a bounded number (15 per sync) of detail lookups (compare, pull request) fill in the commit list, size, forced flag, title and merger; a failed lookup leaves a plainer message. Events already stored are never looked up again.
7. **No webhook route was added.** Routing `push`/`pull_request` webhooks into the same ingest is not trivial in the current handler, and the polling path works alone.
