# Capabilities

* [Capability contract](capability-contract.md) - vocabulary and narrowing rules.
* [Capability matrix](capability-matrix.generated.md) - generated current capability inventory.
* [Capability ledger](capability-ledger.generated.md) - generated history of capability lifecycle changes.

Capabilities are authored in `src/kernel/composition/catalog.source.json`. `src/kernel/composition/capability-registry.ts` and `src/kernel/composition/manifests.ts` are generated from it and are not edited by hand. `npm run package:capability-catalog` emits the public `@alphaci/capability-catalog` artifact and its deterministic `provenance.json` consumed by the frontend. Pack profiles project the same keys; they are not a second catalog. The generated matrix is documentation, while the live compatibility endpoint projects the request's resolved deployment composition.
