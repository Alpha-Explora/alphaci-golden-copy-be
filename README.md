# AlphaCI Enterprise Backend

NestJS 11 backend for FlowCI Studio. The application is currently one deployable progressive hexagonal-clean modular monolith. Microservice extraction is a future option only and is not part of the current runtime.

## Current architecture

The bounded contexts are:

- identity-access — authentication, administration, capabilities, workspaces, hierarchy, and repository access policy
- projects — project lifecycle, catalog, workflows, existing repositories, and project read models
- pipelines — GitHub integration, CI token lifecycle, and CI report ingestion
- runtime — deployment targets, environment metadata, provider connections, provider adapters, and deployment history
- billing — subscriptions, usage, and quota policy
- platform-ops — audit, notifications, feedback, and the PostgreSQL outbox relay

Cross-cutting technical infrastructure lives in src/kernel. Providers such as Render, Vercel, and GCP are plugins inside runtime, not separate bounded contexts.

## Quick start

Requirements: Node.js 22 or compatible, npm, and a PostgreSQL/Supabase connection for database-backed operation.

~~~bash
npm ci
cp .env.example .env
npm run start:dev
~~~

The complete environment contract is in .env.example. Never commit .env or credentials.

## Verification

~~~bash
npm run typecheck
npm run lint
npm test
npm run build
~~~

Architecture and migration checks:

~~~bash
npm run boundaries
npm run check:application-boundaries
npm run check:provider-encapsulation
npm run check:schema-ownership
npm run report:architecture-metrics -- --json
npm run db:apply:all -- --dry-run
~~~

The optional k6 health smoke test is in tests/performance/smoke.js.

## Operations

- npm run start:prod — starts the compiled HTTP application after npm run build
- npm run process:outbox — runs one compiled outbox relay pass
- npm run db:apply:all -- --dry-run — lists the globally ordered migrations without applying them
- npm run db:hierarchy:verify — checks the deployed hierarchy schema state
- npm run check:github-teams — read-only GitHub team-role synchronization preflight
- node dist/scripts/reconcile-deleted-repos.js — scheduled GitHub repository-deletion reconciliation after build

The active outbox table is platform.outbox_events. It has one scheduled owner, scripts/process-outbox.cjs, and at-least-once delivery. Handlers must be idempotent.

## Deployment

Dockerfile is the production image definition. render.yaml defines the scheduled outbox relay. Managed Render and Vercel provisioning behavior is documented in:

- docs/deployment-provisioning.md
- docs/deployment-provisioning-live-smoke.md

The live smoke checklist creates external resources and requires explicit approval before execution.

## Architecture documentation

- docs/architecture/FUTURE_STATE.md — current six-context tree and future-only extraction posture
- docs/architecture/MODULE_CONSOLIDATION_PLAN.md — current-versus-future module design
- docs/architecture/DDD_CONTEXT_MAP.md — ownership and domain language
- docs/architecture/CROSS_CONTEXT_CONTRACTS.md — ports, context seams, and event model
- docs/architecture/SCHEMA_OWNERSHIP.md — migration and SQL ownership rules
- docs/architecture/REMEDIATION_EVIDENCE.md — verification evidence and known limits
- supabase/RECONCILIATION.md — database migration reconciliation record

## Boundary rules

1. Keep business ownership in a bounded context.
2. Keep provider-specific behavior inside runtime.
3. Import other contexts through public indexes or focused serialisable ports.
4. Keep kernel technical-only; it must not import src/modules.
5. Keep transport DTOs, persistence records, and domain contracts separate.
6. Add an outbox, job, or event only when retry, durability, or independent work requires it.
