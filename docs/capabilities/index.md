# Capabilities

* [Capability contract](capability-contract.md) - vocabulary and narrowing rules.
* [Capability matrix](capability-matrix.generated.md) - generated current capability inventory.
* [Capability ledger](capability-ledger.generated.md) - generated history of capability lifecycle changes.

The application-owned capability registry is `src/kernel/composition/capability-registry.ts`, and edition applicability is declared by `src/kernel/composition/manifests.ts`. `npm run package:capability-catalog` emits the public `@alphaci/capability-catalog` artifact consumed by the frontend. Pack profiles project the same keys; they are not a second catalog. The generated matrix is documentation, while the live compatibility endpoint projects the request's resolved deployment composition.
