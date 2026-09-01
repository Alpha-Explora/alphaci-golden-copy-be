# Changelog

## [Unreleased]

### Added

- Added an OKF v0.2 current-state documentation bundle covering architecture, capabilities, composition packs, runbooks, and change history.
- Added generated context, event, provider, route, schema, architecture-check, and capability maps.
- Added repository checks for OKF structure, lower-kebab documentation names, stale plan-specific claims, edition branches, and generated-map drift.
- Added an executive Golden Copy report covering Enterprise-first priorities, parallel implementation workstreams, delivery gates, and evidence requirements.
- Clarified the executive report in plain language, including how the detailed documentation connects to capabilities, packs, runbooks, evidence, and leadership reporting.
- Made the executive report self-contained by including the necessary current-state, pack, capability, operating, and evidence summaries.
- Made the executive report context-independent and drop-in ready by including its complete explanation, status, priorities, and parallel delivery model.

### Changed

- Replaced obsolete architecture and operational document locations with current lower-kebab canonical paths.
- Synchronized the npm lockfile with the existing `js-yaml` dependency so clean `npm ci` installation succeeds.
- Kept the existing HTTP route inventory, public DTO compatibility, and product workflow behavior while tightening internal delivery and composition boundaries.
- Composed Runtime provider contributions through validated provider packs, retaining the current Render, Vercel, and GCP registrations and compatibility fields.
- Changed the PostgreSQL outbox relay to claim rows with short leases, release the database transaction before handler I/O, and acknowledge only the matching claim.
- Made hierarchy member offboarding and revoke-event publication share one transaction, so a failed enqueue rolls back the member and assignment changes together.
- Made the scheduled hierarchy relay require an explicit `live` or `stub` mode instead of relying on an implicit deployment default.
- Updated the outbox reliability migration, topic quarantine migration, and rollback procedures to document the active schema and recovery behavior.

### Fixed

- Corrected outbox acknowledgement to update the active `published_at` column rather than the removed legacy `processed_at` column.
- Added fail-closed protection to the branch-scoped environment rollback so it cannot silently discard preview branch identity in the legacy schema.
- Preserved hierarchy failure context when GitHub repository or user resolution fails, allowing retry and audit handling to retain the group and acting-user context.

### Verification

- Documentation verification: `npm run check:documentation`.
- Full local verification: see [the local verification runbook](docs/runbooks/runbook-local-verification.md).
