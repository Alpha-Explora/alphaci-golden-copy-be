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
- These E1 APIs manage environment metadata only. They do not create branches,
  provision deployment targets, or change generated deploy workflows; project
  provisioning and deployment continue through the legacy fixed path.
- Project creation rejects an ordered `environments` array before repository or
  GitHub writes until E3 provides environment-aware provisioning.

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
