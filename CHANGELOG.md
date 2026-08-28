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
- Kept the runtime behavior, API surface, provider behavior, migration SQL, and outbox delivery logic unchanged.

### Verification

- Documentation verification: `npm run check:documentation`.
- Full local verification: see [the local verification runbook](docs/runbooks/runbook-local-verification.md).
