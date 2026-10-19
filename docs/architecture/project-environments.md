---
type: "Project Contract"
title: "Project environments"
description: "Project-owned ordered environment identity and its compatibility boundary."
tags: [projects, environments, api, deployment]
status: stable
sources:
  - id: "environment-api"
    resource: "src/modules/projects/api/project-environments.controller.ts"
    title: "Project environment API"
  - id: "environment-schema"
    resource: "supabase/migrations/projects/20260925050000_project_environments.sql"
    title: "Project environment persistence"
  - id: "environment-targets"
    resource: "supabase/migrations/runtime/20260928100000_deployment_target_environments.sql"
    title: "Deployment targets keyed by environment"
---

# Project environments

A project may store an ordered list of deployment environments. Each record has
a stable UUID, permanent per-project slug, editable display name, position,
source branch, role (production or non_production), and a read-only
autoDeploy value. Positions start at zero and remain contiguous. Only
position zero has autoDeploy: true; exactly one environment is production.
Distinct environments may use the same source branch.

The project API supports:

- GET /projects/:projectId/environments to list environments in position order.
- POST /projects/:projectId/environments to append an environment.
- PATCH /projects/:projectId/environments/:environmentId to change only its
  display name.
- These APIs manage environment metadata only. They do not create branches or
  change generated deploy workflows; project provisioning continues through
  the legacy fixed path.
- Project creation accepts an ordered `environments` array for
  single-repository and two-repository (`multi-repo`) projects (see below).
  A project with both services in one repository rejects one before any
  repository or GitHub write.

The environment definition accepts complete ordered lists and requires exactly
one production environment at any position. The editable `dev → uat → main`
template describes a future configuration; it does not affect deployment
behavior before E3 makes provisioning and workflows environment-aware.
When an environment is added to an empty legacy project, that first addition
must be production so the API does not create a partially configured
environment list. Later additions must be non-production. Slugs, IDs, source
branches, roles, and order cannot be edited through this API, and there is no
delete operation. Those changes need a separate migration flow because
provider targets, secrets, and history will later refer to environment
identity.

Existing project deployment selection continues to use its legacy branch-based
path until an environment mapping is explicit. The additive backfill creates
one production record only where exactly one project target identifies one
branch and a Render target explicitly identifies that branch as production
without relying on the legacy branch-derived `main` or `production` labels.
Projects with multiple targets, candidate branches, or no unambiguous
production setting remain without environment rows; an empty list therefore
means legacy compatibility remains active and operator mapping is required.
This migration does not alter targets, branches, providers, or hosted
resources.

## Deployment targets by environment

A deployment target may belong to one environment. The target key is
(project, environment, slot), with one provider and a stable target ID. The
branch is the environment's source setting; it never selects a target. Two
environments that share a branch therefore get separate targets, and the
env-var metadata and custom domains stored per target stay separate.

- POST /projects/:projectId/deployment-targets with `environmentId` creates
  the target for that environment. The branch is the environment's source
  branch; a different `branchName` is rejected. A second target for the same
  environment and slot is rejected.
- PUT /projects/:projectId/deployment-targets/:targetId/environment attaches a
  legacy target to an environment whose source branch it already deploys. The
  target ID is kept, so its env vars and domains stay attached. A target
  attached to one environment cannot move to another.
- GET /projects/:projectId/deployment-targets?environmentId=... lists that
  environment's targets; every target response includes `environmentId`,
  which is null on the legacy branch path.
- GET /projects/:projectId/environments/:environmentId/deployment-targets/:slot
  returns the environment's target and its URLs. It answers 404 when no target
  is configured and 409 when the target is missing or failed. Other modules
  use the same rule through `ENVIRONMENT_DEPLOYMENT_TARGET_RESOLVER`; there is
  no fallback to another provider or to a branch lookup.

Before a target is created or attached, the repository's GitHub Environment
named by the environment slug is created or updated and limited to deployments
from its source branch; any other branch rule on it is removed. GitHub creates
an unprotected environment the first time a workflow names one, so this runs
before generated workflows reference it. If it fails, nothing is created at
the provider. Required reviewers are an operator setting on the GitHub
Environment.

The migration attaches an existing target only when exactly one environment of
its project uses the target's branch and the target is the only one for that
project, slot, and branch. Every other target keeps a null `environmentId`
and its existing branch-based behavior until an operator attaches it.

## Creating a project with environments

A single-repository project created with an `environments` list stores the
environments in the given order, creates each distinct source branch once
from `main`, and protects every branch except the first environment's
(`main` is always protected). It then provisions one target per environment
and requested slot through the environment-aware target path, which also
provisions each GitHub Environment, and finally generates the environments
pipeline, naming those environment and target IDs, and pushes it to every
source branch. The response lists the branches actually created.

### Two-repository projects

A two-repository project (`repoShape: multi-repo`) created with an
`environments` list is two project rows, one per repository. Each row stores
the same environments under its own IDs. Each repository then goes through
the same environment pipeline as a single-repository project, limited to the
slot it deploys: the backend repository gets the `backend` targets and the
frontend repository gets the `frontend` targets. Each repository has its own
branches, release signing, generated pipeline, releases and promotions. A
target with the `standalone` slot is rejected for this shape. After both
repositories exist, the backend and frontend targets of each environment are
cross-linked by the same pass that a hosted pair uses.

The two rows are linked the same way as every two-repository project. Both are
filed under the same delivery project, so `ProjectLinkPort.getProjectFolder`
returns each row as a sibling repository of the other. Both rows have
`repoShape` `multi-repo`, and each generated pipeline names the other
repository as its sibling. The create response returns the backend row as `id`
and the frontend row as `secondaryProjectId`.

Host assignment after creation runs for both rows. The `hostAssignment` config
of an environment has one port entry and one health entry per slot. Each row
is assigned with the entries for its own slot, the shared ingress, and the
same machine. The server allocates host ports per machine, so the two rows
cannot collide. For a two-repository project, each `hostAssignments` entry
names its `projectId` and `slot`, and failure messages name the repository.

If the frontend repository fails during creation, everything created for it is
removed and the backend repository stays usable. The response then has
`secondaryRepoError`.
