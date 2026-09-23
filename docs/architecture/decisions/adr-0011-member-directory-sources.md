---
type: "Decision"
title: "Member directory sources"
description: "Decide who may join a workspace through one per-deployment directory source, served by a public API."
tags: [architecture, decision, identity, hierarchy]
status: stable
timestamp: "2026-09-23T00:00:00Z"
sources:
  - id: orthogonal-axes
    resource: "/architecture/decisions/adr-0002-orthogonal-product-axes.md"
    title: "Orthogonal product axes"
  - id: provider-boundaries
    resource: "/architecture/decisions/adr-0004-provider-and-port-boundaries.md"
    title: "Provider and port boundaries"
  - id: client-policies
    resource: "/architecture/decisions/adr-0009-client-capability-policies.md"
    title: "Client capability policies"
---
# ADR-0011: Member directory sources

**Decision date:** 2026-09-23
**Decision status:** Accepted
**Scope:** Who may be added to a workspace, on every client deployment

## Decision

A deployment has one member directory: the people its workspaces draw members from. A person may join a workspace when the directory lists them and they have an active AlphaCI account. The workspace member picker, the add-member check, and `GET /api/v1/directory/members` all ask the same `MemberDirectoryService`, so a person offered in one place is never refused in another.

Where the directory comes from is deployment configuration. `MEMBER_DIRECTORY_SOURCE` selects one `MemberDirectorySource` implementation in `DirectoryModule`:

- `github_org`, the default, lists the members of `MEMBER_DIRECTORY_ORG`, which defaults to `GITHUB_ENFORCED_ORG`. The roster is read with the signed-in caller's own GitHub token, then the caller's App installation, then the organization's App installation.
- `accounts` lists every active account on the deployment. It is for an installation whose sign-in already decides who belongs, such as an on-prem deployment behind its own identity provider.

An unknown source value stops the boot. A source that cannot be read answers 503 with its reason. It never answers with an empty directory.

The public endpoint serves the directory to the people in it and to nobody else. `GET /api/v1/directory` names the source and organization, so a client system can say which directory it is showing.

## Rejected alternatives

- Gating on `identity.app_users.is_internal` was rejected. That flag is only written when `GITHUB_INTERNAL_ORG` is set, so on every other deployment, a sold one included, the directory was empty and nobody could be added to any workspace.
- Carrying the directory in a client capability policy was rejected. ADR-0009 policies are deny-only capability lists, and a directory is where people come from, not a capability.
- Reading the roster only through a GitHub App installation was rejected. A fresh or rebuilt database has no installation rows, and the picker listed nobody. The caller's token is the one credential every deployment has.
- One interface per consumer was rejected. The picker, the add check, and client systems share one service, which keeps their answers identical.

## Consequences

- A new kind of directory, such as SSO/SCIM or another identity provider, is one `MemberDirectorySource` subclass and one factory branch. No consumer changes.
- A directory member who has never signed in is listed with `hasAccount: false`. They cannot be added until they sign in once, because there is no account row to attach a membership to.
- The `github_org` source caches the roster for one minute per deployment, so a member added on GitHub appears within a minute.
- The `accounts` source lets a lead add any account on the deployment. Choose it only where sign-in is already restricted.

## Verification

Focused coverage lives in `src/modules/identity-access/directory/application/member-directory.service.spec.ts`, `src/modules/identity-access/directory/infrastructure/github-org.directory-source.spec.ts`, and the `readOrganizationMembers` block of `src/modules/pipelines/github/infrastructure/github.service.spec.ts`. `tests/architecture/http-boot.spec.ts` proves the booted app composes the default source.
