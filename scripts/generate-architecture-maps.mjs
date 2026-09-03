#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const NODE_SCRIPTS = path.join(ROOT, 'scripts');
const require = createRequire(import.meta.url);
const { schemaOwnershipSnapshot } = require('./check-schema-ownership.cjs');

const CONTEXTS = [
  {
    id: 'identity-access',
    owns: 'authentication, administration, capabilities, workspaces, hierarchy, and repository access policy',
    publicApi: 'src/modules/identity-access/index.ts',
    prohibited: 'project entities, provider clients, and billing policy',
    schemas: ['identity', 'orgs', 'hierarchy'],
  },
  {
    id: 'projects',
    owns: 'project lifecycle, catalog, workflows, existing repositories, and project read models',
    publicApi: 'src/modules/projects/index.ts',
    prohibited: 'provider credentials, provider clients, and deployment persistence',
    schemas: ['projects', 'workflow'],
  },
  {
    id: 'pipelines',
    owns: 'GitHub integration, CI token lifecycle, and CI report ingestion',
    publicApi: 'src/modules/pipelines/index.ts',
    prohibited: 'project authorization, provider APIs, and deployment policy',
    schemas: ['github_app', 'ci', 'workflow'],
  },
  {
    id: 'runtime',
    owns: 'deployment targets, environment metadata, domains, provider connections, provider adapters, and deployment history',
    publicApi: 'src/modules/runtime/index.ts',
    prohibited: 'project authorization, project persistence, and billing policy',
    schemas: [
      'runtime',
      'env_provisioning',
      'runtime_deployments',
      'runtime_domains',
      'runtime_secrets',
      'gcp_operations',
    ],
  },
  {
    id: 'billing',
    owns: 'subscriptions, usage, and quota policy',
    publicApi: 'src/modules/billing/index.ts',
    prohibited: 'provider registries, provider APIs, and deployment persistence',
    schemas: ['billing', 'usage', 'billing_lifecycle'],
  },
  {
    id: 'platform-ops',
    owns: 'audit, notifications, feedback, and outbox consumers',
    publicApi: 'src/modules/platform-ops/index.ts',
    prohibited: 'business aggregates and provider policy',
    schemas: ['platform', 'audit', 'notifications', 'support'],
  },
];

const PROVIDERS = [
  {
    id: 'gcp',
    label: 'Google Cloud Platform',
    composition: 'src/modules/runtime/infrastructure/providers/gcp/gcp.module.ts',
    implementation: 'src/modules/runtime/infrastructure/providers/gcp/gcp.provider.ts',
    responsibilities: 'GCP deployment provider and Cloud Run/Artifact Registry provisioning',
    slots: 'provider-defined deployment slots',
    availability: 'configuration-gated by GCP deployment settings',
  },
  {
    id: 'render',
    label: 'Render',
    composition: 'src/modules/runtime/runtime.module.ts',
    implementation: 'src/modules/runtime/infrastructure/providers/render/render-deployment.provider.ts',
    responsibilities: 'Render deployment targets, environment variables, policy, and CI secret installation',
    slots: 'backend',
    availability: 'configuration-gated by environment provisioning settings',
  },
  {
    id: 'vercel',
    label: 'Vercel',
    composition: 'src/modules/runtime/runtime.module.ts',
    implementation: 'src/modules/runtime/infrastructure/providers/vercel/vercel-deployment.provider.ts',
    responsibilities: 'Vercel deployment targets, environment variables, preview lane, policy, and CI secret installation',
    slots: 'frontend',
    availability: 'configuration-gated by environment provisioning settings',
  },
];

const EVENT_DETAILS = {
  'platform.audit.recorded': {
    producer: 'contexts using AuditEventPublisher',
    consumer: 'platform-ops / OutboxRelayService / AuditEventsService',
    write: 'best-effort post-commit observability write',
  },
  'platform.notification.requested': {
    producer: 'contexts using NotificationEventPublisher',
    consumer: 'platform-ops / OutboxRelayService / NotificationEventsService',
    write: 'best-effort post-commit notification request',
  },
  'hierarchy.repository_assignment.grant': {
    producer: 'identity-access hierarchy assignment transaction',
    consumer: 'identity-access / GithubSyncOutboxHandler',
    write: 'transactionally coupled to the critical hierarchy mutation',
  },
  'hierarchy.repository_assignment.revoke': {
    producer: 'identity-access hierarchy assignment transaction',
    consumer: 'identity-access / GithubSyncOutboxHandler',
    write: 'transactionally coupled to the critical hierarchy mutation',
  },
};

function posix(value) {
  return value.replace(/\\/g, '/');
}

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(full));
    else files.push(full);
  }
  return files;
}

function sourceFiles(directory) {
  return filesUnder(directory).filter((file) => file.endsWith('.ts'));
}

function relative(file) {
  return posix(path.relative(ROOT, file));
}

function quote(value) {
  return JSON.stringify(value);
}

function concept({ type, title, description, tags, sources = [], body }) {
  const lines = [
    '---',
    `type: ${quote(type)}`,
    `title: ${quote(title)}`,
    `description: ${quote(description)}`,
    `tags: [${tags.join(', ')}]`,
    'status: stable',
  ];
  if (sources.length > 0) {
    lines.push('sources:');
    for (const source of sources) {
      lines.push(`  - id: ${quote(source.id)}`);
      lines.push(`    resource: ${quote(source.resource)}`);
      if (source.title) lines.push(`    title: ${quote(source.title)}`);
    }
  }
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(NODE_SCRIPTS, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${script} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function architectureMetrics() {
  return JSON.parse(runNode('report-architecture-metrics.cjs', ['--json']));
}

function parseOutboxTopics() {
  const text = fs.readFileSync(path.join(ROOT, 'src/kernel/events/outbox-topics.ts'), 'utf8');
  const topicNames = [...text.matchAll(/^\s{2}(\w+):\s*'([^']+)'/gm)].map((match) => ({
    name: match[1],
    topic: match[2],
  }));
  const owners = new Map(
    [...text.matchAll(/^\s*\[OUTBOX_TOPICS\.(\w+)\]:\s*'([^']+)'/gm)].map(
      (match) => [match[1], match[2]],
    ),
  );
  return topicNames
    .map(({ name, topic }) => ({
      name,
      topic,
      owner: owners.get(name) ?? 'unassigned',
      ...(EVENT_DETAILS[topic] ?? {
        producer: 'not documented',
        consumer: 'not documented',
        write: 'not documented',
      }),
    }))
    .sort((left, right) => left.topic.localeCompare(right.topic));
}

function routeInventory() {
  const manifest = readJson(
    path.join(DOCS, 'architecture/route-inventory.manifest.json'),
  );
  const routeFile = path.join(
    DOCS,
    'architecture',
    manifest.referenceFile,
  );
  const routes = fs
    .readFileSync(routeFile, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (routes.length !== manifest.routeCount) {
    throw new Error(
      `Route manifest count ${manifest.routeCount} does not match ${routes.length} routes`,
    );
  }
  return { manifest, routes };
}

function renderSchemaReferenceList(references) {
  return references.length === 0
    ? 'none'
    : references.map((reference) => `\`${reference}\``).join(', ');
}

function generateContextMap(metrics) {
  const rows = CONTEXTS.map((context) => {
    const metric = metrics.find((item) => item.module === context.id);
    return `| \`${context.id}\` | ${context.owns} | \`${context.publicApi}\` | ${context.schemas.map((schema) => `\`${schema}\``).join(', ')} | ${metric.sourceFiles} source files / ${metric.testFiles} tests |`;
  });
  return concept({
    type: 'Architecture Map',
    title: 'Bounded context map',
    description: 'Generated ownership map for the six current NestJS bounded contexts.',
    tags: ['architecture', 'map', 'ownership'],
    sources: [
      { id: 'context-source', resource: 'src/modules', title: 'Current context source tree' },
      { id: 'metrics-source', resource: 'scripts/report-architecture-metrics.cjs', title: 'Architecture metrics generator' },
    ],
    body: `# Bounded context map

This map is generated from the current source tree and architecture metrics. It records ownership in the one NestJS deployable; it does not create additional deployables or alter runtime behavior.

## Contexts

| Context | Owns | Public boundary | Owned schemas | Measured source/test files |
|---|---|---|---|---|
${rows.join('\n')}

The technical kernel at \`src/kernel/\` is shared infrastructure for database access, configuration, HTTP concerns, session contracts, event persistence, and focused ports. It has no business-context ownership.

## Boundary rule

Production context callers use a context public index, a serialisable contract, or an injected focused port. Context composition roots may import Nest feature modules to assemble the current in-process graph. Dependency-cruiser remains the authoritative import graph; this map is an ownership and trend view.

## Regeneration

Run \`npm run generate:architecture-maps\`. CI uses \`npm run generate:architecture-maps -- --check\` to reject stale output.`,
  });
}

function generateEventsMap() {
  const topics = parseOutboxTopics();
  const rows = topics.map(
    (event) => `| \`${event.topic}\` | \`${event.owner}\` | ${event.producer} | ${event.consumer} | ${event.write} |`,
  );
  return concept({
    type: 'Event Map',
    title: 'Current event and outbox map',
    description: 'Generated map of the PostgreSQL outbox topics, owners, and active in-process relay.',
    tags: ['architecture', 'events', 'map', 'operations'],
    sources: [
      { id: 'topic-source', resource: 'src/kernel/events/outbox-topics.ts', title: 'Outbox topic registry' },
      { id: 'relay-source', resource: 'src/modules/platform-ops/application/outbox-relay.service.ts', title: 'Active outbox relay' },
      { id: 'schema-source', resource: 'supabase/migrations/identity-access/20260606_domain_schema_bootstrap.sql', title: 'Outbox table migration' },
    ],
    body: `# Current event and outbox map

The active event mechanism is a PostgreSQL-backed outbox inside the one NestJS deployable. It is an asynchronous in-process work queue. It is not a broker, and it does not create a network hop.

## Registered topics

| Topic | Owner | Producer | Handler | Write semantics |
|---|---|---|---|---|
${rows.join('\n')}

## Delivery path

1. A producer calls the kernel event publisher or the owning hierarchy repository.
2. \`OutboxRepository\` inserts into \`platform.outbox_events\`. Critical hierarchy transitions call \`publishInTransaction\` on the same PostgreSQL client as the state mutation. Audit and notification publishers use explicit best-effort post-commit writes.
3. \`OutboxDispatcher\` registers one handler for each active topic.
4. \`scripts/process-outbox.cjs\` starts the compiled Nest application context and invokes \`OutboxRelayService\`.
5. The Render cron in \`render.yaml\` is the deployment-level scheduler. A short \`FOR UPDATE SKIP LOCKED\` transaction assigns an expiring lease before a handler runs, so external I/O does not hold a database connection or process-wide lock.
6. Successful rows become \`status = 'published'\` with \`published_at\`. Failed rows are retried with \`available_at\`, then quarantined after the configured attempt limit. Acknowledgement and failure updates require the lease token.

Delivery is at-least-once. A handler can run again if the process stops after the side effect and before the acknowledgement update, so handlers must remain idempotent. The topic allow-list prevents an unowned row from being acknowledged by the wrong handler.

## Operator references

See the [outbox relay runbook](/runbooks/runbook-outbox-relay.md), the [PostgreSQL outbox decision](/architecture/decisions/adr-0005-postgresql-outbox-delivery.md), and the [current architecture](/architecture/current-architecture.md).`,
  });
}

function generateProviderMap() {
  const rows = PROVIDERS.map((provider) => {
    for (const source of [provider.composition, provider.implementation]) {
      if (!fs.existsSync(path.join(ROOT, source))) {
        throw new Error(`Provider source does not exist: ${source}`);
      }
    }
    return `| \`${provider.id}\` | ${provider.label} | ${provider.responsibilities} | ${provider.slots} | ${provider.availability} |`;
  });
  return concept({
    type: 'Provider Map',
    title: 'Runtime provider map',
    description: 'Generated inventory of the provider plugins currently composed by Runtime.',
    tags: ['architecture', 'providers', 'runtime', 'map'],
    sources: [
      { id: 'runtime-source', resource: 'src/modules/runtime', title: 'Runtime context source tree' },
      { id: 'provider-composition', resource: 'src/modules/runtime/runtime.module.ts', title: 'Runtime composition root' },
    ],
    body: `# Runtime provider map

Providers are Runtime-owned plugins. A provider contribution pack groups its descriptor, policy, runtime client, workflow fragment, and CI secret installer. The generic registries expose provider-neutral contracts to application code; provider implementations stay under \`src/modules/runtime/infrastructure/providers/\`.\n
## Current providers

| Provider id | Label | Responsibility | Supported slot | Availability |
|---|---|---|---|---|
${rows.join('\n')}

## Composition rules

- Provider identifiers are runtime data and are registered through Runtime composition.
- Each configured provider contributes one validated \`RuntimeProviderPack\`; optional components may be omitted only when the advertised capability does not require them.
- Runtime consumers receive provider-neutral catalog data, focused ports, or contracts; they do not receive provider implementation methods from another context.
- A provider may have configuration-gated live behavior. The catalog reports enabled state and selected capabilities from the registered provider.
- Existing Render and Vercel compatibility classes remain provider-owned, while \`RuntimeModule\` assembles their packs. Adding a provider still requires one composition binding; the generic registries do not change.

See the [provider and port decision](/architecture/decisions/adr-0004-provider-and-port-boundaries.md) and the [deployment provisioning runbook](/runbooks/runbook-deployment-provisioning.md).`,
  });
}

function generateRouteMap() {
  const { manifest, routes } = routeInventory();
  return concept({
    type: 'Route Map',
    title: 'HTTP route map',
    description: `Generated inventory of the ${manifest.routeCount} current API routes.`,
    tags: ['architecture', 'http', 'routes', 'map'],
    sources: [
      { id: 'route-reference', resource: 'docs/architecture/route-inventory.baseline.txt', title: 'Checked-in pre-PR route baseline' },
      { id: 'route-manifest', resource: 'docs/architecture/route-inventory.manifest.json', title: 'Route inventory manifest' },
    ],
    body: `# HTTP route map

The current compiled API exposes **${routes.length} routes** under the global \`/api/v1\` prefix. The list below is generated from the checked-in pre-PR baseline used by the route inventory test.

## Routes

${routes.map((route) => `- \`${route}\``).join('\n')}

## Verification

The route inventory test compares the current compiled route list with the checked-in pre-PR baseline. The reference manifest records a SHA-256 digest and its source commit. Update the baseline only when an intentional API route change is reviewed.`,
  });
}

function generateSchemaMap() {
  const snapshot = schemaOwnershipSnapshot();
  const rows = Object.entries(snapshot.owners)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([owner, schemas]) => `| \`${owner}\` | ${schemas.map((schema) => `\`${schema}\``).join(', ')} |`,
    );
  const migrationAllowances = Object.entries(snapshot.legacyMigrationReferences)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([file, references]) => `| \`${file}\` | ${renderSchemaReferenceList(references)} |`,
    );
  const sourceAllowances = Object.entries(snapshot.transitionalSourceReferences)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([file, references]) => `| \`${file}\` | ${renderSchemaReferenceList(references)} |`,
    );
  return concept({
    type: 'Schema Ownership Map',
    title: 'Database schema ownership map',
    description: 'Generated schema ownership and explicit transition-reference inventory.',
    tags: ['architecture', 'database', 'schema', 'map'],
    sources: [
      { id: 'ownership-source', resource: 'scripts/check-schema-ownership.cjs', title: 'Schema ownership gate' },
      { id: 'migration-source', resource: 'supabase/migrations', title: 'Current migration tree' },
    ],
    body: `# Database schema ownership map

This map is generated from the owner and exact transition-reference data used by \`scripts/check-schema-ownership.cjs\`. It documents current ownership without changing schemas, roles, search paths, or migration replay order.

## Owners

| Owner | Schemas |
|---|---|
${rows.join('\n')}

\`workflow\` is intentionally listed for both Projects and Pipelines because the current database contains workflow-generation and CI-run tables. Ownership is table-level in the source gate where the distinction matters.

## Explicit migration transition references

These are exact file-to-schema.table allowances required for historical migrations to remain replayable. They are not blanket filename exemptions.

| Migration file | Allowed transition references |
|---|---|
${migrationAllowances.join('\n')}

## Explicit source transition references

These are exact source-file allowances for current cross-context reads or shared technical tables. New references fail the gate until ownership is reviewed and recorded precisely.

| Source file | Allowed transition references |
|---|---|
${sourceAllowances.join('\n')}

## Verification

Run \`npm run check:schema-ownership\` and \`npm run db:apply:all -- --dry-run\`. The first checks qualified and resolvable inline SQL; the second verifies globally sorted migration replay order.`,
  });
}

function generateArchitectureChecks(metrics) {
  const total = metrics.reduce(
    (summary, item) => {
      summary.sourceFiles += item.sourceFiles;
      summary.testFiles += item.testFiles;
      summary.crossModuleImports += item.crossModuleImports;
      summary.crossContextPairCount += item.crossContextPairCount;
      summary.contractCrossContextImports += item.contractCrossContextImports;
      summary.applicationCrossContextImports += item.applicationCrossContextImports;
      summary.deadInProcessAdapters += item.deadInProcessAdapters;
      return summary;
    },
    {
      sourceFiles: 0,
      testFiles: 0,
      crossModuleImports: 0,
      crossContextPairCount: 0,
      contractCrossContextImports: 0,
      applicationCrossContextImports: 0,
      deadInProcessAdapters: 0,
    },
  );
  const rows = metrics.map(
    (item) => `| \`${item.module}\` | ${item.sourceFiles} | ${item.testFiles} | ${item.crossModuleImports} | ${item.crossContextPairCount} | ${item.contractCrossContextImports} | ${item.applicationCrossContextImports} |`,
  );
  return concept({
    type: 'Architecture Checks',
    title: 'Architecture check map',
    description: 'Generated snapshot of source metrics and the repository architecture gates.',
    tags: ['architecture', 'checks', 'map', 'verification'],
    sources: [
      { id: 'metrics-source', resource: 'scripts/report-architecture-metrics.cjs', title: 'Architecture metrics generator' },
      { id: 'boundary-source', resource: '.dependency-cruiser.cjs', title: 'Authoritative dependency graph configuration' },
      { id: 'capability-gate', resource: 'scripts/check-capabilities.cjs', title: 'Capability registry gate' },
      { id: 'ci-source', resource: '.github/workflows/ci.yml', title: 'Continuous integration gate' },
    ],
    body: `# Architecture check map

This snapshot is generated from the current source tree. It is descriptive evidence; the executable gates remain the commands in the verification table.

## Context metrics

| Context | Source files | Test files | Cross-context imports | Directional pairs | Contract imports | Application imports |
|---|---:|---:|---:|---:|---:|---:|
${rows.join('\n')}

| Total | ${total.sourceFiles} | ${total.testFiles} | ${total.crossModuleImports} | ${total.crossContextPairCount} | ${total.contractCrossContextImports} | ${total.applicationCrossContextImports} |

Dead in-process adapters measured by the source report: **${total.deadInProcessAdapters}**.

## Executable gates

| Gate | Command | Authority |
|---|---|---|
| Type safety | \`npm run typecheck\` | TypeScript compiler |
| Build | \`npm run build\` | TypeScript build configuration |
| Lint and tests | \`npm run lint\` and \`npm test -- --ci --runInBand\` | ESLint and Jest |
| Dependency boundaries | \`npm run boundaries\` | dependency-cruiser |
| Application boundaries | \`npm run check:application-boundaries\` | cross-context contract/application rule checker |
| Provider encapsulation | \`npm run check:provider-encapsulation\` | provider ownership checker |
| Schema ownership | \`npm run check:schema-ownership\` | migration and inline SQL checker |
| Capability registry | \`npm run check:capabilities\` | AppConfig flag ownership, capability dependency, and pack catalog completeness checker |
| Migration order | \`npm run db:apply:all -- --dry-run\` | migration replay planner |
| OKF bundle | \`npm run check:okf\` | OKF v0.2 bundle validator |
| Documentation | \`npm run check:documentation\` | naming, stale-claim, generated-map, and documentation policy checker |

## Limits

Static gates do not prove a live database connection, deployed cron execution, provider API availability, or external rollback. Those checks are covered by the relevant integration and operational runbooks when their environment is configured.`,
  });
}

function readCapabilityRegistry() {
  const file = path.join(DOCS, 'capabilities/registry.ts');
  const source = fs.readFileSync(file, 'utf8');
  const match = /export const CAPABILITIES = (\[[\s\S]*?\])\s+as const;\s*$/m.exec(
    source,
  );
  if (!match) throw new Error('Capability registry must export a JSON-shaped CAPABILITIES array');
  return JSON.parse(match[1]);
}

function generateCapabilityMatrix() {
  const capabilities = readCapabilityRegistry();
  const rows = capabilities.map(
    (capability) => `| \`${capability.key}\` | \`${capability.context}\` | ${capability.description} | ${capability.maturity} | ${capability.editions.join(', ')} | ${capability.configuration} |`,
  );
  return concept({
    type: 'Capability Map',
    title: 'Capability matrix',
    description: 'Generated documentation inventory of current capability keys and their compatibility posture.',
    tags: ['capabilities', 'map', 'packs'],
    sources: [
      { id: 'capability-registry', resource: 'docs/capabilities/registry.ts', title: 'Documentation capability registry' },
      { id: 'capability-gate', resource: 'scripts/check-capabilities.cjs', title: 'Capability registry gate' },
      { id: 'capability-endpoint', resource: 'src/modules/identity-access/capabilities/capabilities.controller.ts', title: 'Compatibility capability endpoint' },
    ],
    body: `# Capability matrix

This matrix is generated from the documentation registry at \`docs/capabilities/registry.ts\`. It describes current compatibility keys and does not replace the existing \`/api/v1/capabilities\` response or implement entitlement resolution.

| Capability key | Context | Description | Maturity | Editions with documented applicability | Configuration source |
|---|---|---|---|---|---|
${rows.join('\n')}

## Interpretation

- **stable** means the compatibility surface is present in the current repository.
- **limited** means the key is present but its live adapter or provider behavior is intentionally limited or configuration-gated.
- **not-implemented** means the product area is explicitly recorded as absent from this backend; it is not an entitlement claim.

Pack profiles list every key in this table, in this order. Pack status is derived from maturity and edition applicability: \`not-applicable\` means the pack does not include the capability; \`not-implemented\` means the pack includes it and the backend does not provide it. Pack-specific gaps that are not registry keys stay in Explicit non-support.`,
  });
}

const OUTPUTS = [
  ['docs/architecture/context-map.generated.md', generateContextMap],
  ['docs/architecture/events-map.generated.md', generateEventsMap],
  ['docs/architecture/provider-map.generated.md', generateProviderMap],
  ['docs/architecture/route-map.generated.md', generateRouteMap],
  ['docs/architecture/schema-ownership.generated.md', generateSchemaMap],
  ['docs/architecture/architecture-checks.generated.md', generateArchitectureChecks],
  ['docs/capabilities/capability-matrix.generated.md', generateCapabilityMatrix],
];

function writeOrCheck(relativePath, content, check) {
  const file = path.join(ROOT, relativePath);
  if (check) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (current !== content) {
      console.error(`Generated output is stale: ${relativePath}`);
      return false;
    }
    return true;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

function main() {
  const check = process.argv.includes('--check');
  const metrics = architectureMetrics();
  let clean = true;
  for (const [relativePath, generator] of OUTPUTS) {
    clean = writeOrCheck(relativePath, generator(metrics), check) && clean;
  }
  if (!clean) process.exitCode = 1;
  else console.log(`${check ? 'Checked' : 'Generated'} ${OUTPUTS.length} architecture and capability map(s).`);
}

main();
