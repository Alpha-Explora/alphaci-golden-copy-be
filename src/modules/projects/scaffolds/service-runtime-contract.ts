import type { ServiceRuntimeContract } from '#kernel/ports/deployment-runtime.port';

/**
 * The stacks the scaffold can emit.
 *
 * Declared here rather than in `scaffold.builder.ts` so a per-stack scaffold
 * can read its runtime contract without importing the builder that calls it,
 * which would be a cycle. The builder re-exports it.
 */
export type CanonicalStack =
  | 'nestjs'
  | 'nodejs'
  | 'nextjs'
  | 'react'
  | 'dotnet';

/**
 * What each generated app serves in its container: the port and the health
 * path. This table is the source of truth. The Dockerfiles, the listen
 * settings, the health routes and the docker-compose ports read from it, and
 * on-prem uses it as the default assignment for a project AlphaCI scaffolded.
 * `service-runtime-contract.spec.ts` builds every scaffold and fails if one of
 * them serves something else.
 *
 * - nestjs: `ENV PORT`, `app.listen(process.env.PORT)` and a `/health` controller.
 * - nodejs: `ENV PORT` and `EXPOSE`. The starter has no HTTP server yet; the
 *   code a developer adds should listen on `PORT` and answer `/health`, the
 *   path every backend release is probed on.
 * - dotnet: `ASPNETCORE_URLS` and `MapGet("/health")`.
 * - nextjs: `next start` on `PORT`; the starter page answers `/`.
 * - react: nginx listens on the port and serves `index.html` at `/`.
 */
export const SCAFFOLD_RUNTIME_CONTRACTS = {
  nestjs: { slot: 'backend', containerPort: 3000, healthPath: '/health' },
  nodejs: { slot: 'backend', containerPort: 3000, healthPath: '/health' },
  dotnet: { slot: 'backend', containerPort: 8080, healthPath: '/health' },
  nextjs: { slot: 'frontend', containerPort: 3000, healthPath: '/' },
  react: { slot: 'frontend', containerPort: 8080, healthPath: '/' },
} as const satisfies Readonly<Record<CanonicalStack, ServiceRuntimeContract>>;
