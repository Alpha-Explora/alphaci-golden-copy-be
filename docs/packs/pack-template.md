---
type: "Template"
title: "Composition pack profile template"
description: "Standard current-state headings for comparable AlphaCI composition pack profiles."
tags: [packs, template, contracts]
status: stable
sources:
  - id: pack-contract
    resource: "/packs/pack-contract.md"
    title: "Composition pack contract"
---
# Composition pack profile template

Use the exact headings below for each pack profile. Replace bracketed values with evidence from the current repository.

## Identity

- Pack ID: `[saas|edu|enterprise]`
- Display name: `[name]`

## Current composition

- Documentation status: `documentation-only`
- Runtime selection behavior: `[describe only if implemented]`
- Current backend applicability: `[evidence]`

## Capability status

List every registry capability in registry order. Do not sample. Status must match the shared catalog rule in the [pack contract](pack-contract.md).

| Capability key | Status | Evidence or limit |
|---|---|---|
| `context.capability` | `available` / `configuration-gated` / `not-implemented` / `not-applicable` | `[evidence]` |

## Deployment scope

[Describe deployment targets separately from the pack identity.]

## Configuration and entitlements

[Record current configuration keys and narrowing behavior.]

## Explicit non-support

[Name product behaviors that are not registry keys. Registry-declared absences use `not-implemented` rows.]

## Ownership and verification

- Context owner: `[context]`
- Source: `[path]`
- Verification: `[command]`
