# SaaS-to-Enterprise Backend Takeaways

Status: review-only. This report records reusable behavior and design evidence from the SaaS backend. It does not implement, copy, or migrate any product or infrastructure code.

## Scope and snapshot

Compared local snapshots:

- SaaS source: `C:/Users/anton/Codes/Alpha Explora/AlphaCI/alphaci-be`, commit `4a5fb6c4af63f17bfceb2d2f7f864dac2adc50ba` (2026-08-15).
- Enterprise target: `C:/Users/anton/Codes/Alpha Explora/AlphaCi Enterprise/alphaci-enterprise-be`, commit `aeb3653b053210842eea1a147f15a339f2b1d551` (2026-09-03).
- Both working trees were clean during review. No fetch, dependency installation, source-code implementation, migration, or provider mutation was performed.

These are local snapshots, not a claim about the current live services or the latest remote branches.

## Bottom line

Use `alphaci-be` as a behavior, edge-case, test, and operational-pattern reference. Do not transplant its seven-service topology into Enterprise.

Enterprise already has an intentional one-deployable, six-context model, explicit public indexes and ports, Runtime-owned provider packs, schema ownership, and a PostgreSQL outbox. The safe transfer unit is therefore a capability or invariant, rehomed into its owning Enterprise context:

1. Identity and self-serve workspace behavior are the clearest product-level gaps.
2. SaaS billing contains valuable lifecycle and payment-safety behavior, but Enterprise intentionally removed the payment gateway; it is a conditional future capability, not code to copy.
3. Runtime, projects, pipelines, notifications, feedback, and most deployment behavior already exist in Enterprise. SaaS is most useful there as a gap and regression-test catalogue.
4. SaaS support intake is a plausible missing capability, but its direct email call must not be copied into Enterprise application code.
5. SaaS event-versioning, inbox idempotency, and Cloud Run promotion controls are useful patterns only when an Enterprise boundary actually needs them.

## Architecture comparison

| Concern | SaaS `alphaci-be` | Enterprise backend | Takeaway |
|---|---|---|---|
| Deployment shape | Seven independently deployable NestJS/Cloud Run apps: six domain services plus `edge-gateway`. | One NestJS deployable with six bounded-context roots and a technical kernel. | Preserve Enterprise composition. Service decomposition is not a capability. |
| Product boundaries | App-per-domain plus shared `libs`. | `identity-access`, `projects`, `pipelines`, `runtime`, `billing`, `platform-ops`; cross-context access is through public indexes and focused ports. | Rehome behavior into the existing owner instead of adding an app. |
| Billing | Checkout, PayMongo/APICenter payment flows, trials, recurring lifecycle, payment projection, usage and runtime credits. | Subscription entitlement and quota policy; checkout is explicitly not implemented for SaaS and not applicable to the Enterprise pack. | Take lifecycle rules as design evidence only if self-serve billing is approved. |
| Runtime | Customer-runtime app owns GCP provisioning, reconciliation, deployments, previews, secrets, and entitlements. | Runtime owns provider packs for GCP, Render, and Vercel, plus deployment history, provisioning, drift, previews, and environment handling. | Compare invariants and tests; do not copy the SaaS provider/application split. |
| Events | Versioned Zod event registry, Pub/Sub relay/consumer, and idempotent inbox. | One PostgreSQL outbox with topic allow-list, leases, lease tokens, retry/quarantine, and handler timeouts. | Preserve the current Enterprise outbox. Add SaaS patterns only for a real new boundary. |
| Identity/workspaces | GitHub, Google, email verification/login, connected identities, workspace invitations, transfer, and personal/team flows. | GitHub auth and account lifecycle plus Enterprise hierarchy, groups, systems, repositories, assignments, and direct membership rules. | Take self-serve flows selectively; do not flatten hierarchy semantics. |
| Delivery | Service-specific image build, immutable Artifact Registry digest, Cloud Run candidate with no traffic, readiness verification, optional promotion, WIF. | Single application image and Render outbox cron; GCP is a Runtime provider and on-prem GitOps is a separate proposed target. | Take promotion safety and workload identity controls when the target requires them, not the seven-service topology. |

Structural counts support the comparison but are not quality scores: the SaaS snapshot contains 443 application source files and 122 app tests; Enterprise contains 432 source files across the six contexts and 112 context tests.

## Capability transfer matrix

| SaaS slice | Enterprise home | What is worth taking | Guardrail | Priority |
|---|---|---|---|---|
| `identity-workspace` | `identity-access/auth` and `identity-access/workspaces` | Email verification/login, Google OAuth, connected-identity behavior, invitation lifecycle, workspace transfer, and the associated acceptance tests. | Resolve personal/team workspace rules and map SaaS roles to Enterprise hierarchy roles before any endpoint work. | High, conditional on product scope |
| `billing-subscriptions` | `billing` | Trial intent hashing/expiry, offer quoting and reservation, payment-method fingerprinting, idempotency, ordered event projection, and bounded subscription lifecycle transitions. | Do not copy PayMongo tables, webhooks, hosted checkout, or payment credentials into the current Enterprise pack. | High design reference; no current implementation |
| `customer-runtime` | `runtime` | Desired-state reconciliation, idempotent provisioning jobs, approval/report callback rules, locking, concurrency/credit checks, preview cleanup, and secret metadata semantics. | Use `RuntimeProviderPack` and provider-neutral ports; keep on-prem behavior distinct from GCP. | Medium; mostly gap analysis |
| `project-management` | `projects` | Scaffold/template edge cases, workflow-settings semantics, repository import/setup behavior, drift/repair expectations, and CI/deployment test cases. | Enterprise already has lifecycle provisioning, scaffolding, workflow settings, workspace APIs, and project tests. | Medium; avoid wholesale copy |
| `pipeline-gateway` | `pipelines` plus the project workspace API | GitHub Actions/report translation edge cases, token-scope behavior, branch/PR/file/log semantics, and repository provisioning cases. | Do not port the large SaaS `github.service.ts`; preserve Enterprise hierarchy and provider/port boundaries. | Medium; test/reference only |
| `platform-ops` support | `platform-ops` | Support request taxonomy, screenshot validation, HTML escaping, confirmation/team notification intent, and bounded attachment rules. | Put email behind an application port and infrastructure adapter; add PII retention, abuse/rate limits, and attachment scanning decisions. | Medium candidate |
| `libs/contracts` and `libs/messaging` | `kernel/events` only when needed | Versioned event schemas, explicit topic registry, malformed-event handling, inbox deduplication, and replay/idempotency test ideas. | Do not introduce Pub/Sub or a second event mechanism merely for SaaS parity. | Low/conditional |
| SaaS Docker/workflows/Terraform | Enterprise deployment/provider documentation and CI | Non-root container execution, immutable digest promotion, no-traffic candidate deploys, readiness checks, WIF, and failure-safe traffic behavior. | Apply only to a selected Enterprise deployment target; this does not change the one-deployable product boundary. | Medium/conditional |

## Findings by area

### 1. Identity and workspaces: useful behavior, incompatible vocabulary

The SaaS auth surface in `apps/identity-workspace/src/http/auth.controller.ts` includes email signup and verification, email login, Google OAuth, GitHub OAuth, connected identities, onboarding, logout, and account lifecycle operations. `workspaces.controller.ts` adds workspace creation, member management, invitations, acceptance/decline, role changes, transfer, and leave behavior.

Enterprise currently exposes the GitHub/account-lifecycle portion through `src/modules/identity-access/auth` and has a substantially richer Enterprise hierarchy under `src/modules/identity-access/hierarchy`. Its group membership model is intentionally direct and its roles include hierarchy-specific concepts; it is not the SaaS invitation model with a different URL prefix.

Recommended use: extract the SaaS flows and tests as a behavioral catalogue, then decide which belong in the SaaS composition pack. If approved, the Enterprise destination is `identity-access`, with explicit decisions for:

- personal workspace versus team workspace as the source of truth;
- `owner/admin/developer/viewer` versus Enterprise hierarchy roles;
- invitation state, expiry, transfer, and offboarding semantics;
- email delivery, OAuth identity linking, session claims, and abuse controls;
- interaction with the independent edition, tenancy, deployment-target, and feature-flag axes.

### 2. Billing: the most valuable reference and the clearest “do not copy”

SaaS billing is materially richer. The controller and application services cover capabilities, trial intents, quotes, payment-method setup, checkout/payment intents, payment history, refunds, recurring activation/cancellation, workspace billing, and provider webhooks. The implementation also contains several good safety patterns:

- trial tokens are short-lived and stored as hashes;
- trial quotes reserve an offer and are consumed transactionally;
- payment methods use a fingerprint and idempotency key without routing card credentials through the backend;
- payment events use an inbox, issuer/service-account checks, schema validation, ordering, and malformed-event acknowledgement;
- subscription workers bound trial conversion, grace, expiry, and cancellation transitions.

Enterprise has deliberately moved in the opposite product direction. `supabase/migrations/billing/20260819000000_remove_payment_gateway.sql` records removal of hosted checkout, provider webhooks, card vaulting, payment attempts, and refunds while retaining plan catalog, subscriptions, entitlements, and quota reads. The current Enterprise subscription controller is correspondingly limited to entitlement reads and administrative activation/cancellation.

Recommendation: retain the SaaS billing code as design evidence for a future self-serve SaaS capability. Do not treat the difference as a migration gap. Any future approval should start with a new billing contract and security/data-flow review, then re-express the required behavior inside Enterprise `billing` and its outbox/schema ownership rules.

### 3. Runtime: take invariants, not another runtime architecture

SaaS `customer-runtime` demonstrates useful operational semantics: idempotent provisioning, target locking, reserved-credit and concurrency checks, explicit approval/report callbacks, bounded reconciliation, safe error mapping, preview limits/cleanup, and secret metadata operations. The GCP adapter covers Cloud Run, Artifact Registry, service accounts, WIF, and Secret Manager.

Enterprise already has the corresponding seam: `src/modules/runtime/core/provider-pack.ts`, provider registries, provider-neutral application ports, deployment history, provisioning jobs, drift/preview handling, and GCP/Render/Vercel provider implementations. The source and tests show that Enterprise deliberately keeps vendor policy in Runtime providers.

Recommendation: use SaaS runtime tests to identify missing Enterprise invariants or regression cases. Keep the implementation in Enterprise Runtime and require provider-neutral contracts; do not import the SaaS `customer-runtime` module or make GCP assumptions part of the kernel.

### 4. Projects and pipelines: mostly already absorbed

Enterprise already has project lifecycle provisioning, scaffold building, repository import/setup, workflow settings, CI validation/reporting, deployment history, previews, drift/repair, project workspace APIs, GitHub repository operations, Actions runs/jobs/logs, pull requests, secrets, and branch protection.

The SaaS repositories are still useful for comparing behavior and tests, particularly around scaffold normalization, workflow previews, repository setup failures, token scopes, GitHub Actions result translation, and partial deployment outcomes. The correct transfer is a focused gap list or test case, not the SaaS `project-management` or `pipeline-gateway` applications.

### 5. Support intake: a genuine candidate, with a boundary correction

SaaS `platform-ops` includes a support endpoint with typed request categories, optional PNG/JPEG screenshots capped at 5 MB, HTML escaping, and team/submitter email notifications. Enterprise has feedback, notifications, audit, and admin facilities but no equivalent support intake surface.

This is a plausible Enterprise capability if customer support is in scope. The SaaS `SupportService` calls an external email API directly from application code; that is not a safe copy for Enterprise. The Enterprise version should first decide retention, tenant/user identity, attachment storage and scanning, rate limits, redaction, and the email port/adapter boundary.

### 6. Events and deployment operations: reuse the safety ideas selectively

The SaaS event registry and idempotent inbox are useful if Enterprise later introduces a separate worker, service, or external integration that consumes versioned events. They are not a reason to replace the current PostgreSQL outbox.

Enterprise’s outbox already owns durable publication, topic ownership, leasing, lease-token acknowledgement, retry/quarantine, and handler timeouts. For the current one-deployable architecture, adding Pub/Sub would increase operational surface without adding a required boundary.

The SaaS deployment workflow’s immutable digest, no-traffic candidate, readiness verification, and WIF model are strong operational controls. They can inform a future Enterprise GCP delivery path or CI policy. They do not imply that Enterprise should adopt an edge gateway or seven Cloud Run services.

## Do not take

- The SaaS seven-service/edge-gateway topology, private east-west HTTP, per-service deployment roles, or service-local search paths.
- SaaS payment gateway tables, PayMongo/APICenter webhook handlers, hosted checkout endpoints, or card/payment storage.
- The SaaS support application service’s direct external email call.
- SaaS role, workspace, or subscription vocabulary without mapping it to Enterprise hierarchy and orthogonal product axes.
- Vendor-specific runtime behavior in the kernel or a new top-level context.
- `START_HERE_BACKEND.md` and FlowCI-era documentation as canonical Enterprise architecture; use source and current Enterprise contracts instead.
- Endpoint parity as a sufficient acceptance criterion. Authorization, lifecycle transitions, idempotency, concurrency, auditability, and route compatibility still need explicit review.

## Decision gates before any implementation

1. Confirm which capabilities are actually wanted in the Enterprise SaaS composition: additional auth providers, invitations, self-serve billing/trials, support intake, or only behavioral hardening.
2. Write the domain mapping for user, personal workspace, team workspace, hierarchy group, edition, tenancy, deployment target, and subscription entitlement.
3. Select only the SaaS behaviors that close an approved gap, and turn their existing tests/edge cases into Enterprise acceptance criteria.
4. Review schema ownership, secrets/PII, external-provider trust, idempotency, outbox behavior, and authorization before selecting a vertical slice.
5. Implement later as a small Enterprise-context change with boundary and runtime verification; do not begin by copying an SaaS app or adding a seventh context.

## Verification performed

Static architecture checks passed in both snapshots:

- SaaS module boundaries and application boundaries passed; its architecture metrics reported five documented baseline cross-app imports and no actionable application violations.
- Enterprise application boundaries, provider encapsulation, schema ownership, capability registry, and architecture metrics passed. The metrics’ provider-import count is expected to be covered by the provider encapsulation rule.
- Enterprise Jest completed with 145 passed suites, 1 skipped suite, 1,356 passed tests, and 3 skipped tests.
- SaaS full Jest was not run because the local checkout has no installed `node_modules/jest`; dependencies were not installed for this review.
- Live Supabase, GitHub, GCP, PayMongo, Cloud Run, and deployment verification were not attempted.

The resulting conclusion is evidence-backed at the source and test level, but remains a proposal for product prioritization. No implementation is implied by this report.
