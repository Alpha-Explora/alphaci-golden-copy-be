# Directory Update Log

## 2026-09-03

* **Update**: Recorded that the frontend repository keeps a matching current-state bundle that snapshots this catalog.
* **Update**: Recorded pack-specific target capabilities as `not-implemented` registry keys, with `not-applicable` pack status when a pack does not include the capability.
* **Update**: Allowed empty `configurationFlags` on `not-implemented` records so absent product areas do not invent AppConfig flags.
* **Update**: Made the SaaS, EDU, and Enterprise pack profiles list every current registry capability in registry order, with status derived from maturity and edition applicability.
* **Update**: Added pack catalog completeness to `check:capabilities` so sampled or reordered pack tables fail the documentation gate.

## 2026-09-02

* **Update**: Bound the capability registry to real application configuration with `configurationFlags` and `requires`, so a renamed `AppConfig` flag can no longer leave the registry and generated matrix silently green.
* **Update**: Added the `check:capabilities` gate covering flag existence, two-way flag ownership, dependency resolution, acyclicity, and edition-narrowing of dependencies.
* **Update**: Pinned `*.txt` to LF so the generated route-inventory baseline hash is stable on Windows checkouts.

## 2026-09-01

* **Update**: Documented the current leased PostgreSQL outbox relay, explicit hierarchy sync mode, topic ownership, and recovery procedures.
* **Update**: Recorded provider-pack composition as the current Runtime boundary without changing provider behavior or public compatibility fields.
* **Update**: Added rollback-safety guidance for branch-scoped environment data and aligned the architecture references with the active migration and transaction behavior.
* **Update**: Tightened rollback preflight to reject any preview data whose branch identity cannot survive the legacy schema, and made outbox topic filtering fail closed for unregistered strings.

## 2026-08-28

* **Creation**: Established the current-state OKF v0.2 documentation bundle.
* **Update**: Added architecture, capability, pack, and operational navigation.
* **Update**: Added generated maps and repository validation for documentation drift.
* **Update**: Added the executive report with Enterprise-first priorities, parallel workstreams, delivery gates, and evidence requirements.
* **Update**: Reworked the executive report into plain language and added the relationship between detailed documentation, capabilities, packs, runbooks, evidence, and leadership reporting.
* **Update**: Made the executive report self-contained so readers can understand the current position and implementation approach without opening other documents.
* **Update**: Made the report context-independent and drop-in ready by putting the complete explanation, current status, pack relationship, priorities, and parallel delivery model in one document.
