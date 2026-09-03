---
type: "Executive and Implementation Report"
title: "AlphaCI Golden Copy executive and implementation report"
description: "A self-contained, plain-language current-state report and Enterprise-first implementation brief for AlphaCI."
tags: [executive, product, architecture, governance, enterprise, implementation]
status: stable
---

# AlphaCI Golden Copy executive and implementation report

## Quick summary

- **Current position:** AlphaCI is one product with six clearly owned areas. It is still being built and improved.
- **Delivery priority:** Enterprise readiness comes first.
- **Approach:** Build shared foundations once, then use them for Enterprise, SaaS, and EDU.
- **Main control:** A feature is not called available until it has an owner, working behavior, tests, operating instructions, and suitable proof.
**Document purpose:** Give a new reader the full picture without needing prior history or another document.

AlphaCI currently provides project, workflow, CI, deployment, identity, billing, and platform-operation capabilities in one application. The Golden Copy explains what exists, what is limited, what is not built, how the parts fit together, and how the remaining work will be delivered.

## 1. What this document is

This is a deliberate mix of a **report** and **documentation**.

| Report role | Documentation role |
|---|---|
| Explains where AlphaCI is today. | Explains how the product is organized. |
| States what is most important next. | Explains capabilities, packs, operations, and proof. |
| Highlights risks and decisions. | Defines the steps for implementing and checking work. |
| Gives leadership a short, usable view. | Gives delivery teams enough context to work consistently. |

The Golden Copy is the complete reference set. This document is the self-contained summary and implementation guide within that set. It should be understandable on its own and should not depend on a particular person, meeting, branch, or earlier explanation.

## 2. The simple connection between all the parts

The pieces fit together in this order:

```text
Architecture
  tells us who owns each area
      ↓
Capability
  tells us what the product can do
      ↓
Pack
  groups capabilities for SaaS, EDU, or Enterprise
      ↓
Runbook
  tells people how to use, check, recover, or support it
      ↓
Evidence
  shows whether the claim is true
      ↓
Report
  summarizes status, priorities, risks, and decisions
```

### Plain-language definitions

| Term | Meaning |
|---|---|
| Architecture | The map of the product and the area responsible for each job. |
| Capability | One useful feature or promise the product can provide. |
| Pack | A named group of capabilities for a customer type. |
| Runbook | A step-by-step instruction for operating, checking, changing, or recovering the product. |
| Evidence | A test, check, or approved real-environment result that supports a claim. |
| Golden Copy | The maintained set of current product, architecture, operating, and evidence records. |
| Executive report | The readable summary of current status, delivery order, risks, and proof. |

The architecture says **where** responsibility lives. The capability list says **what** is provided. The packs say **how the capabilities are grouped**. The runbooks say **how the work is operated**. Evidence says **whether the statement is trustworthy**. This report brings those answers together.

## 3. Current product shape

AlphaCI is one application with six owned areas. This keeps deployment and day-to-day operation simple while giving each area clear responsibility.

| Product area | Everyday responsibility |
|---|---|
| Identity and access | Sign-in, users, workspaces, roles, hierarchy, and deciding who may access what. |
| Projects and workflows | Projects, repositories, project setup, and the instructions used to build projects. |
| Pipelines and CI | GitHub connections, automated build activity, and build-result reporting. |
| Runtime and deployments | Environments, hosting targets, domains, deployment history, and hosting-provider connections. |
| Billing and usage | Subscriptions, usage tracking, limits, and quota rules. |
| Platform operations | Activity records, notifications, feedback, health, and background tasks. |

The current hosting choices are GCP, Render, and Vercel. They are hosting options inside the Runtime area, not separate versions of AlphaCI.

### Background work and the outbox

Some actions cannot finish during the original request. For example, an access change may need a follow-up action with GitHub, or an important activity may need to be recorded.

AlphaCI handles this by saving a task in the database and having one scheduled process work through the task list:

1. The application saves the task.
2. The scheduled process picks it up.
3. Successful work is marked complete.
4. Temporary failures are tried again.
5. Repeated failures are set aside for review.
6. The action must be safe to repeat if the process stops at an awkward moment.

This is the current outbox approach. It is a reliable background task list inside the application, not a separate messaging product.

## 4. Current capability and pack status

### Capability status

The capability list is shared across all packs. A capability is not copied three times for SaaS, EDU, and Enterprise. Each pack profile lists every current registry capability in that same order so the three catalogs can be compared row by row.

| Capability area | What is currently covered | Current status |
|---|---|---|
| Identity and access | Workspaces, membership, hierarchy, repository assignments, and access management. | Stable across SaaS, EDU, and Enterprise. SSO/SCIM, LMS/LTI, cohort policy, education provisioning, FERPA workflows, and runtime pack entitlement resolution are recorded as not implemented. |
| Platform operations | Activity records and in-product notifications. | Stable across SaaS, EDU, and Enterprise. Customer data-location controls are not implemented. |
| Billing and usage | Usage tracking and quota checks. | Limited; configuration and product rules apply. Self-serve checkout is not implemented. |
| Runtime and hosting | Environment setup, deployment history, previews, drift checking, and drift repair. | Limited; setup and provider support are required. Managed secrets, air-gap packaging, and customer-managed isolation are not implemented. |
| Projects and workflows | Project synchronization, workflow preview, workflow update requests, and target management. | Stable or limited depending on the capability and setup. |
| Pipelines and CI | Build-result intake and tracking. | Limited; CI setup and reporting are required. GitHub Enterprise Server support is not implemented. |

### Pack status

Packs are customer-facing groupings and comparison tools. They do not automatically switch features on and do not create separate product logic.

| Pack | What it means | Current status |
|---|---|---|
| SaaS | Shared hosted capabilities for general customers. | Lists the shared catalog. Checkout and runtime pack entitlement resolution are not implemented. Marketing-site behavior is not a backend capability. |
| EDU | Shared capabilities considered for education environments. | Lists the shared catalog. LMS/LTI, cohort policy, FERPA workflows, education identity provisioning, and runtime pack entitlement resolution are not implemented. |
| Enterprise | Shared capabilities held to stricter access, security, operating, and evidence standards. | Lists the shared catalog under the Enterprise evidence bar. SSO/SCIM, GitHub Enterprise Server, managed secrets, air-gap packaging, data-location controls, customer-managed isolation, and runtime pack entitlement resolution are not implemented. |

### Capabilities recorded as not implemented

These catalog keys must remain `not-implemented` until they have working behavior and proof. Pack rows use `not-applicable` when the key is outside that pack.

| Capability key | Packs that include it |
|---|---|
| `identity.sso-scim` | Enterprise |
| `identity.lms-lti` | EDU |
| `identity.cohort-policy` | EDU |
| `identity.edu-provisioning` | EDU |
| `identity.ferpa-workflows` | EDU |
| `identity.edition-entitlements` | SaaS, EDU, and Enterprise |
| `billing.checkout` | SaaS |
| `platform.data-residency` | Enterprise |
| `runtime.managed-secrets` | Enterprise |
| `runtime.air-gap-packaging` | Enterprise |
| `runtime.customer-isolation` | Enterprise |
| `pipelines.github-enterprise-server` | Enterprise |

The report deliberately distinguishes “described” from “available.” This prevents a pack description from becoming an accidental customer promise.

## 5. Why Enterprise is first

Enterprise customers need confidence that customer access, data, delivery, records, recovery, and support will work predictably. These are also good foundations for SaaS and EDU.

Enterprise-first means:

1. Protect customer access and separation before adding optional features.
2. Make deployments, hosting choices, credentials, and recovery dependable.
3. Make important actions traceable and background work recoverable.
4. Make database changes safe and understandable.
5. Build shared capabilities once so every pack benefits.
6. Keep Enterprise-specific claims honest until they are implemented and proven.

Enterprise-first does not mean stopping shared product development or creating a separate product for each pack.

## 6. Enterprise-first implementation order

The product is still being built, so work is prioritized in layers.

| Priority | Area | Plain-language goal | Ready when |
|---|---|---|---|
| P0 | Access and customer separation | The right people can see and change the right customer information. | Permission tests, separation tests, administrative review, and support instructions pass. |
| P0 | Safe delivery and hosting | Deployments and hosting changes are controlled, understandable, and recoverable. | Hosting tests, setup checks, recovery instructions, and approved real-environment checks pass where needed. |
| P0 | Records and background work | Important actions are recorded and follow-up tasks are not silently lost. | Record coverage, retry/review tests, repeat-safety review, scheduler proof, and replay instructions exist. |
| P0 | Data safety | Database changes, access rules, and recovery are controlled. | Ownership review, migration rehearsal, access review, reconciliation, and recovery proof exist. |
| P1 | Enterprise connections | Add identity, repository, secret, data-location, and customer-managed operating options. | Product contract, security review, tests, operating instructions, and approved environment proof exist. |
| P1 | Enterprise administration | Give enterprise operators the visibility and controls needed to run AlphaCI. | Administrative tests, records, support procedures, and acceptance scenarios pass. |
| P2 | SaaS and EDU refinement | Improve the other packs using the same shared foundation. | Pack comparison, capability status, regression tests, and release history are updated. |

The order describes delivery attention. It does not change the current six-area product structure.

## 7. How every feature will be implemented

Each feature or improvement follows the same path:

1. **Describe the outcome.** State what a customer, user, or operator should be able to do.
2. **Name the capability.** Give the feature one stable name and a clear status.
3. **Assign one owner.** Choose the product area responsible for the rules, data, and behavior.
4. **Identify connections.** Note whether it affects access, hosting, data, background work, or another area.
5. **Build a small complete slice.** Keep the behavior in its owning area and avoid broad rewrites.
6. **Test success and failure.** Check normal use, permissions, bad input, service failures, retries, and recovery as appropriate.
7. **Write the operating steps.** Explain how to check, support, recover, or replay the behavior.
8. **Update the packs.** Use the same status and limitation language for SaaS, EDU, and Enterprise.
9. **Collect proof.** Run automated checks and approved real-environment checks where local tests are not enough.
10. **Record the change.** Update the relevant product record, architecture record, operating instructions, evidence record, change history, and this report when its leadership status changes.

This makes documentation part of delivery rather than a separate activity at the end.

## 8. How implementation will happen in parallel

Different areas can be built at the same time. What cannot happen in parallel is two teams independently defining the same customer promise, data ownership, background task, or hosting rule.

| Workstream | Main responsibility | Main result |
|---|---|---|
| A. Shared definitions | Keep the common capability names, pack language, ownership rules, and evidence standards consistent. | One shared vocabulary and current reference. |
| B. Enterprise access | Build sign-in, customer separation, roles, workspaces, hierarchy, administration, and access records. | Trusted access behavior and proof. |
| C. Enterprise delivery | Build hosting connections, environments, credentials, deployments, recovery, and provider controls. | Controlled delivery and recovery behavior. |
| D. Data and reliability | Build database changes, background tasks, retries, review handling, and operational visibility. | Safe data changes and dependable follow-up work. |
| E. Testing and release | Test every stream, protect existing behavior, combine evidence, and prepare release decisions. | Release-ready evidence and honest status. |

### Parallel working rules

1. Agree on the capability name and owner before work begins across areas.
2. Keep one owner for each customer promise, data area, task type, and hosting contract.
3. Keep changes small enough to review and combine regularly.
4. Publish shared definition changes before other streams build on them.
5. Keep code, tests, operating instructions, and status updates together.
6. A missing real-environment check lowers the status; it does not justify an unsupported availability claim.
7. Run the shared checks continuously, not only at the end.

## 9. Delivery stages

| Stage | What happens | Exit question |
|---|---|---|
| 0. Common baseline | Record the current product, shared vocabulary, and status rules. | Can a new reader understand the product and its current limits? |
| 1. Enterprise foundation | Agree on access, data, delivery, background-work, and proof requirements. | Does every P0 area have an owner and a way to verify it? |
| 2. Parallel build | Workstreams deliver independent slices against the shared definitions. | Does each slice include behavior, tests, operating steps, and status? |
| 3. Combined verification | Test the connections between access, delivery, data, background work, and support. | Are release-scoped risks visible and addressed? |
| 4. Controlled release | Release the approved scope with honest pack status and usable procedures. | Can the team operate, support, and recover what was released? |

Independent work can overlap between stages. A release cannot skip combined verification or proof review.

## 10. Definition of ready

An item can be called ready only when:

- the customer outcome and capability name are clear;
- one product area owns the behavior;
- access, data, hosting, and background-work effects are understood;
- normal and failure behavior are tested at the right level;
- operating, support, recovery, or replay steps are written;
- all affected packs use accurate status and limits;
- automated checks are current;
- required real-environment proof is recorded;
- the change history is updated;
- the Enterprise release questions below have acceptable answers.

## 11. Enterprise release questions

Before presenting a capability as Enterprise-ready, ask:

1. Can each customer and administrator access only what they are allowed to access?
2. Can we explain where customer information lives, who controls it, and how it is changed safely?
3. Can we deploy, monitor, recover, and roll back the behavior using clear instructions?
4. Can important follow-up work be traced, retried, reviewed, and safely repeated?
5. Can an operator support the capability without relying on undocumented knowledge?
6. Do the capability list and all three packs use the same status and limits?
7. Is there real-environment proof wherever a written check is not enough?

If any answer is not yet acceptable, the capability remains limited, setup-dependent, or not implemented.

## 12. Risks and controls

| Risk | Level | Control |
|---|---|---|
| The reference becomes outdated. | High | Update the affected records with each material change and run the document and map checks. |
| Enterprise work becomes a separate product copy. | High | Build shared capabilities once and keep one pack and status language. |
| Parallel work creates conflicting definitions. | High | One owner per area and shared contract review before reuse. |
| Hosting details spread into unrelated areas. | High | Keep hosting-specific behavior in the Runtime area and check its boundary. |
| Background work disappears or runs twice. | High | Save tasks durably, prevent overlapping processing, retry failures, review exhausted tasks, and require repeat-safe handling. |
| A data change breaks another area. | High | Review ownership, rehearse changes, check access rules, and record reconciliation evidence. |
| A written check is mistaken for live proof. | Medium | Label local, integrated, deployed, hosting, scheduled-task, and recovery evidence separately. |
| Specialized Enterprise work slows shared product work. | Medium | Run shared P0 work in parallel and keep specialized work behind clear acceptance gates. |

## 13. How the Golden Copy stays current

The Golden Copy is maintained while AlphaCI is being built.

For every material change:

1. Check whether the product structure, capability, pack status, operating steps, hosting, data, background work, risk, or evidence changed.
2. Update the detailed record owned by that area.
3. Update the capability and pack status if the customer promise changed.
4. Update operating instructions if people must operate, support, recover, or replay the change.
5. Re-run the relevant checks.
6. Update the change history.
7. Update this report when the executive status, Enterprise priority, readiness, risk, or proof changes.

The report should remain readable and portable. The detailed records can contain deeper technical material, but a decision-maker should not need them to understand the current position and delivery order.

## 14. Current evidence and limits

| Area | Current position |
|---|---|
| Product structure | One application with six clearly owned areas. |
| Hosting choices | GCP, Render, and Vercel are supported when the required setup is present. |
| Background work | A database-backed task list, one scheduled processor, retries, review handling, and repeat-safe processing are defined. |
| Capability records | Shared capability names and status are recorded for SaaS, EDU, and Enterprise. |
| Pack records | All three packs list the shared catalog. Pack-specific gaps use `not-implemented` or `not-applicable` status. |
| Operating guidance | Verification, database changes, background tasks, hosting, authentication, and performance procedures are recorded. |
| Automated proof | Document format, naming, generated maps, product boundaries, hosting boundaries, data ownership, migration order, tests, and builds can be checked. |
| Enterprise readiness | Shared foundations are in place, but several Enterprise-specific integrations and real-environment proofs are not complete. |
| Live limits | Database, hosting, scheduled-task, rollback, and recovery checks require approved environment access. |
| Known baseline issue | Repository-wide lint and formatting verification is tracked by the local verification runbook; this report does not claim an external CI result. |

## Recommended executive actions

1. Use this document as the portable explanation of the current product and delivery approach.
2. Use the detailed records for implementation and operations, while keeping this report focused on status, priorities, risks, and proof.
3. Keep Enterprise as the acceptance bar for shared access, delivery, reliability, and evidence work.
4. Assign clear owners to the parallel workstreams instead of running competing rewrites.
5. Do not approve an Enterprise availability claim without implementation, test, operating, and evidence records.
6. Keep SaaS and EDU aligned with shared changes without duplicating product logic.
7. Review this report at every material release and whenever priority, readiness, risk, or evidence changes.

The Golden Copy is successful when a new reader can understand what AlphaCI is, what it can do, how the packs relate to the capabilities, what is being built first, how work is shared in parallel, and what proof is still required.
