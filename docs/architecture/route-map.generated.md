---
type: "Route Map"
title: "HTTP route map"
description: "Generated inventory of the 145 current API routes."
tags: [architecture, http, routes, map]
status: stable
sources:
  - id: "route-reference"
    resource: "docs/architecture/route-inventory.baseline.txt"
    title: "Checked-in pre-PR route baseline"
  - id: "route-manifest"
    resource: "docs/architecture/route-inventory.manifest.json"
    title: "Route inventory manifest"
---

# HTTP route map

The current compiled API exposes **145 routes** under the global `/api/v1` prefix. The list below is generated from the checked-in pre-PR baseline used by the route inventory test.

## Routes

- `DELETE /api/v1/admin/users/{id}/role`
- `DELETE /api/v1/auth/account`
- `DELETE /api/v1/groups/{groupId}`
- `DELETE /api/v1/groups/{groupId}/members/{memberId}`
- `DELETE /api/v1/projects/{id}`
- `DELETE /api/v1/projects/{projectId}/deployment-targets/{targetId}`
- `DELETE /api/v1/projects/{projectId}/domains/{domainId}`
- `DELETE /api/v1/projects/{projectId}/env-vars/{metadataId}`
- `DELETE /api/v1/provider-connections/{id}`
- `DELETE /api/v1/repositories/{repositoryId}/assignments/{assignmentId}`
- `DELETE /api/v1/repositories/{repositoryId}/configuration/{configurationType}/{name}`
- `DELETE /api/v1/workspaces/{workspaceId}/members/{memberId}`
- `GET /api/v1`
- `GET /api/v1/admin/access-log`
- `GET /api/v1/admin/admins`
- `GET /api/v1/admin/feedback`
- `GET /api/v1/admin/users`
- `GET /api/v1/admin/users/{id}`
- `GET /api/v1/admin/users/{id}/errors`
- `GET /api/v1/auth/account/pending`
- `GET /api/v1/auth/config-check`
- `GET /api/v1/auth/github/callback`
- `GET /api/v1/auth/github/start`
- `GET /api/v1/auth/me`
- `GET /api/v1/capabilities`
- `GET /api/v1/catalog/categories`
- `GET /api/v1/catalog/central-workflow-tags`
- `GET /api/v1/catalog/project-options`
- `GET /api/v1/catalog/templates`
- `GET /api/v1/catalog/templates/{templateId}`
- `GET /api/v1/ci/runs`
- `GET /api/v1/delivery-projects/{deliveryProjectId}`
- `GET /api/v1/delivery-projects/{deliveryProjectId}/repositories`
- `GET /api/v1/deployment-providers`
- `GET /api/v1/feedback/me`
- `GET /api/v1/github/app/install-url`
- `GET /api/v1/github/installations/accounts`
- `GET /api/v1/github/installations/repos`
- `GET /api/v1/github/repos`
- `GET /api/v1/github/token-scopes`
- `GET /api/v1/groups`
- `GET /api/v1/groups/{groupId}`
- `GET /api/v1/groups/{groupId}/activity`
- `GET /api/v1/groups/{groupId}/eligible-users`
- `GET /api/v1/groups/{groupId}/members`
- `GET /api/v1/groups/{groupId}/systems`
- `GET /api/v1/health`
- `GET /api/v1/me/assigned-repositories`
- `GET /api/v1/me/groups`
- `GET /api/v1/notifications`
- `GET /api/v1/notifications/preferences`
- `GET /api/v1/projects`
- `GET /api/v1/projects/{id}/audit`
- `GET /api/v1/projects/{id}/ci-runs`
- `GET /api/v1/projects/{id}/ci-runs/{runId}`
- `GET /api/v1/projects/{id}/deployments`
- `GET /api/v1/projects/{id}/drift`
- `GET /api/v1/projects/{id}/overview`
- `GET /api/v1/projects/{id}/previews`
- `GET /api/v1/projects/{id}/workflow-settings`
- `GET /api/v1/projects/{projectId}/deployment-targets`
- `GET /api/v1/projects/{projectId}/deployment-targets/{targetId}/actions`
- `GET /api/v1/projects/{projectId}/deployment-targets/{targetId}/logs`
- `GET /api/v1/projects/{projectId}/deployment-targets/{targetId}/logs/stream`
- `GET /api/v1/projects/{projectId}/domains`
- `GET /api/v1/projects/{projectId}/env-vars`
- `GET /api/v1/projects/{projectId}/workspace/branches`
- `GET /api/v1/projects/{projectId}/workspace/files`
- `GET /api/v1/projects/{projectId}/workspace/jobs/{jobId}/logs`
- `GET /api/v1/projects/{projectId}/workspace/pull-requests`
- `GET /api/v1/projects/{projectId}/workspace/pull-requests/{number}/files`
- `GET /api/v1/projects/{projectId}/workspace/runs`
- `GET /api/v1/projects/{projectId}/workspace/runs/{runId}/jobs`
- `GET /api/v1/provider-connections`
- `GET /api/v1/repositories/{repositoryId}`
- `GET /api/v1/repositories/{repositoryId}/access-status`
- `GET /api/v1/repositories/{repositoryId}/assignments`
- `GET /api/v1/repositories/{repositoryId}/configuration`
- `GET /api/v1/subscription/me`
- `GET /api/v1/systems/{systemId}`
- `GET /api/v1/systems/{systemId}/delivery-projects`
- `GET /api/v1/usage/me`
- `GET /api/v1/workflows/history`
- `GET /api/v1/workspaces/me`
- `GET /api/v1/workspaces/{workspaceId}/members`
- `PATCH /api/v1/admin/feedback/{id}`
- `PATCH /api/v1/admin/users/{id}/app-role`
- `PATCH /api/v1/delivery-projects/{deliveryProjectId}`
- `PATCH /api/v1/groups/{groupId}`
- `PATCH /api/v1/groups/{groupId}/members/{memberId}`
- `PATCH /api/v1/notifications/preferences`
- `PATCH /api/v1/projects/{projectId}/deployment-targets/{targetId}`
- `PATCH /api/v1/repositories/{repositoryId}`
- `PATCH /api/v1/systems/{systemId}`
- `PATCH /api/v1/workspaces/{workspaceId}/members/{memberId}`
- `POST /api/v1/admin/users/{id}/app-role/reset`
- `POST /api/v1/admin/users/{id}/role`
- `POST /api/v1/auth/account/restore`
- `POST /api/v1/auth/account/start-fresh`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/onboarding/complete`
- `POST /api/v1/ci/report`
- `POST /api/v1/ci/validate`
- `POST /api/v1/delivery-projects/{deliveryProjectId}/archive`
- `POST /api/v1/delivery-projects/{deliveryProjectId}/repositories`
- `POST /api/v1/existing-repos/discover`
- `POST /api/v1/existing-repos/setup-pr`
- `POST /api/v1/feedback`
- `POST /api/v1/github/installations`
- `POST /api/v1/github/repos`
- `POST /api/v1/github/webhooks`
- `POST /api/v1/groups`
- `POST /api/v1/groups/{groupId}/archive`
- `POST /api/v1/groups/{groupId}/members`
- `POST /api/v1/groups/{groupId}/reopen`
- `POST /api/v1/groups/{groupId}/systems`
- `POST /api/v1/groups/{groupId}/transfer`
- `POST /api/v1/notifications/{id}/read`
- `POST /api/v1/projects`
- `POST /api/v1/projects/setup`
- `POST /api/v1/projects/sync`
- `POST /api/v1/projects/{id}/ci-runs/{runId}/rerun`
- `POST /api/v1/projects/{id}/drift/run`
- `POST /api/v1/projects/{id}/drift/{findingId}/repair`
- `POST /api/v1/projects/{id}/sync`
- `POST /api/v1/projects/{id}/workflow-settings/pr`
- `POST /api/v1/projects/{id}/workflow-settings/preview`
- `POST /api/v1/projects/{projectId}/deployment-targets`
- `POST /api/v1/projects/{projectId}/deployment-targets/{targetId}/sync`
- `POST /api/v1/projects/{projectId}/domains`
- `POST /api/v1/projects/{projectId}/domains/{domainId}/verify`
- `POST /api/v1/projects/{projectId}/env-vars/provision`
- `POST /api/v1/projects/{projectId}/env-vars/validate`
- `POST /api/v1/provider-connections`
- `POST /api/v1/repositories/{repositoryId}/archive`
- `POST /api/v1/repositories/{repositoryId}/assignments`
- `POST /api/v1/repositories/{repositoryId}/assignments/{assignmentId}/reconcile`
- `POST /api/v1/subscription/monthly/activate`
- `POST /api/v1/subscription/monthly/cancel`
- `POST /api/v1/systems/{systemId}/archive`
- `POST /api/v1/systems/{systemId}/delivery-projects`
- `POST /api/v1/workflows/generate`
- `POST /api/v1/workspaces/{workspaceId}/members`
- `PUT /api/v1/repositories/{repositoryId}/configuration/secrets/{secretName}`
- `PUT /api/v1/repositories/{repositoryId}/configuration/variables/{variableName}`

## Verification

The route inventory test compares the current compiled route list with the checked-in pre-PR baseline. The reference manifest records a SHA-256 digest and its source commit. Update the baseline only when an intentional API route change is reviewed.
