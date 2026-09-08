---
type: "Decision"
title: "Stack as a declared axis"
description: "Derive project stack identity from catalog data rather than inferring it from template filenames, and resolve stack-specific pipeline jobs through a registry."
tags: [architecture, decision, composition, workflows]
status: stable
timestamp: "2026-09-08T00:00:00Z"
sources:
  - id: orthogonal-axes
    resource: "/architecture/decisions/adr-0002-orthogonal-product-axes.md"
    title: "Orthogonal product axes"
  - id: provider-boundaries
    resource: "/architecture/decisions/adr-0004-provider-and-port-boundaries.md"
    title: "Provider and port boundaries"
  - id: catalog-service
    resource: "src/modules/projects/application/catalog/catalog.service.ts"
    title: "Catalog service"
  - id: staged-workflow-builder
    resource: "src/modules/projects/application/workflows/staged-workflow.builder.ts"
    title: "Staged workflow builder"
---
# ADR-0006: Stack as a declared axis

**Decision date:** 2026-09-08
**Decision status:** Accepted
**Scope:** Project stack identity and stack-specific pipeline composition

## Context

[ADR-0002](/architecture/decisions/adr-0002-orthogonal-product-axes.md) established that edition, tenancy, deployment target, and feature flag are independent composition values, and rejected conditional source branches on them. It did not enumerate the project stack, and the stack axis was built the way ADR-0002 rejects.

Stack identity is currently derived twice, from two sources, by two mechanisms that never meet:

```text
generator   workflow-templates/*.properties.json
            -> inferStack(templateId, categories)      string-matching a filename
            -> WorkflowTemplate.stack
            -> isBackend = stack === 'nestjs' || stack === 'nodejs'

catalog     catalog/stacks.json { key, kind, runtime, defaultCommands }
            -> loadEngineProjectOptions()              discards runtime and defaultCommands
```

Both paths live in `CatalogService`. The catalog already declares `kind` and `runtime` as data; the generator re-derives the same facts by matching substrings against a template filename, then narrows them to a boolean.

That boolean is not confined to choosing a test workflow. It selects the test command, the test workflow and job id, the input shape passed to the quality stage, and the `app-type` sent to the production gate. A stack the list does not name is classified as frontend by omission rather than rejected.

The cost is measurable. Adding one stack today requires six coordinated edits across both mechanisms: a `stacks.json` entry, a template whose filename makes `inferStack` return the new value, `inferStack`'s return union, `WorkflowTemplate.stack`, the `isBackend` list, and `CanonicalStack` in the scaffold builder. Miss one and the failure is silent: an unlisted stack becomes a Node project, and the mismatch only surfaces when the generated pipeline runs `npm ci` against a repository that has no lockfile.

## Decision

The stack is an orthogonal axis in the sense of ADR-0002, and is treated as declared data rather than inferred identity.

1. **Stack identity comes from the catalog.** `WorkflowTemplate` carries `kind` and `runtime` sourced from `catalog/stacks.json`. `inferStack` is retired as the source of truth; filename matching may remain only as a compatibility fallback for templates that predate the catalog, and never as the primary path.

2. **Classification is declared, not compared.** `isBackend` becomes `kind === 'backend'`. No source branch compares a stack identifier against a literal to decide behaviour.

3. **Stack-specific jobs resolve through a registry.** A toolchain fragment contributes the jobs for a stack, using the same contract shape as the deployment provider fragments in [ADR-0004](/architecture/decisions/adr-0004-provider-and-port-boundaries.md): a key, and a method returning jobs. The contract lives in `kernel/ports`; implementations live in their owning module.

4. **An unsupported stack fails.** A stack that is asked for and cannot be scaffolded raises an error. Absence of a recorded stack — every project predating the catalog — keeps its existing default.

## Rejected alternatives

- **Adding the new stack to both mechanisms** was rejected. It preserves the split, and the next stack pays the same six-edit cost.
- **Building the toolchain registry on top of `inferStack`** was rejected. The registry would still receive its key from a filename guess, which makes the split permanent behind a better-looking interface.
- **Widening `isBackend` into a three-way conditional** was rejected for the reason ADR-0002 gives: it is a conditional source branch on a composition axis.
- **Deleting `inferStack` outright** was rejected for now. Templates that predate the catalog still resolve through it, and removing it is a separate migration from establishing the declared path.

## Consequences

- Adding a stack becomes one catalog entry and one toolchain fragment. The six-edit path is closed.
- `defaultCommands` and `runtime`, already present in the catalog and previously discarded, become available to the generator. This is what a non-Node stack needs, and it is why the catalog schema did not have to change to accommodate one.
- `kind` has a single definition. The generator stops re-deriving a fact the catalog already states.
- Stack, deployment target, and edition remain independent, so a stack does not imply a provider and a provider does not imply a stack.
- Existing behaviour must not change when the four current stacks are migrated. The generated pipeline for each is expected to be byte-identical before and after; a difference is a defect in the migration, not an improvement.

## Verification

Generated workflow bundles for every stack are compared before and after the migration and must match exactly. The comparison is made against freshly generated output rather than the architecture snapshot, which records deploy jobs and file metadata and would not detect a change to the quality stage.

The documentation check that scans `src/` for edition comparison branches under ADR-0002 extends to stack comparison branches by the same reasoning.
