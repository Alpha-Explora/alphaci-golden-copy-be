// ─── Scaffold builder ─────────────────────────────────────────────────────────
//
// Generates a default project scaffold — an array of { path, content } tuples
// ready to be pushed to a freshly-created GitHub repository. The scaffold gives
// developers a working starting point that is compatible with the ALPHACI CI/CD
// workflows (TypeScript, ESLint, Jest with coverage, SonarQube reporting).
//
// Shape-aware: the scaffold structure varies by repoShape (standalone, monorepo,
// microservices, multi-repo) as well as the technology stack.

import { browserTestDevDependencies } from './application/workflows/browser-test-dependencies';
import { buildBrowserTestStarterFiles } from './scaffolds/browser-test-starter';
import { buildDotnetStandaloneScaffold } from './scaffolds/dotnet-scaffold';
import type { ScaffoldFile } from './scaffolds/scaffold-file';

export type { ScaffoldFile } from './scaffolds/scaffold-file';

export type CanonicalRepoShape =
  | 'standalone'
  | 'monorepo'
  | 'microservices'
  | 'multi-repo';

export type CanonicalStack =
  | 'nestjs'
  | 'nodejs'
  | 'nextjs'
  | 'react'
  | 'dotnet';

/**
 * Accept legacy FE/API project type IDs as well as catalog stack keys. Older
 * saved requests and tests still use values like 'nestjs-api' and 'react-app',
 * but the scaffold needs canonical stack names to emit the right file tree.
 *
 * Two different things used to share one fallback, and only one of them was
 * benign:
 *
 *   nullish  → a project with no recorded stack, which is every project
 *              predating the catalog. Defaulting these to nodejs is correct.
 *   unknown  → a stack that was explicitly asked for and is not supported.
 *              Defaulting these produced a repository scaffolded as Node —
 *              package.json, tsconfig, ESLint, a Node Dockerfile — for someone
 *              who asked for something else, with nothing anywhere reporting
 *              the substitution. The pipeline then ran `npm ci` against it and
 *              failed for a reason unrelated to the actual mistake.
 *
 * The same reasoning is already written down one function below, for repo
 * shapes: a catalog-driven request must never silently fall back.
 */
export function normalizeProjectStack(
  stack: string | null | undefined,
): CanonicalStack {
  const normalized = (stack ?? '').trim().toLowerCase();

  if (normalized === '') {
    return 'nodejs';
  }

  if (normalized.includes('dotnet')) {
    return 'dotnet';
  }

  if (normalized.includes('next')) {
    return 'nextjs';
  }

  if (normalized.includes('react') && !normalized.includes('react-native')) {
    return 'react';
  }

  if (normalized.includes('nest')) {
    return 'nestjs';
  }

  if (normalized.includes('node')) {
    return 'nodejs';
  }

  throw new Error(
    `Unsupported project stack '${stack}'. The scaffold can emit nextjs, react, nestjs, nodejs or dotnet; a stack outside that set needs a scaffold before it can be provisioned.`,
  );
}

/**
 * Map a repo shape ID to its canonical form. The catalog (and therefore the
 * FE) uses the short IDs 'mono' and 'multi', while internal flow logic uses
 * 'monorepo' and 'multi-repo'. Accept both so a catalog-driven request never
 * silently falls back to the standalone flow.
 */
export function normalizeRepoShape(
  repoShape: string | null | undefined,
): CanonicalRepoShape {
  switch (repoShape) {
    case 'mono':
    case 'monorepo':
      return 'monorepo';
    case 'multi':
    case 'multi-repo':
      return 'multi-repo';
    case 'microservices':
      return 'microservices';
    default:
      return 'standalone';
  }
}

export interface BuildScaffoldOptions {
  serviceName: string;
  /** 'nestjs' | 'nodejs' | 'nextjs' | 'react' */
  stack: string;
  includeDocker: boolean;
  nodeVersion?: string;
  /**
   * Declared runtime version for stacks that do not run on Node, from the
   * catalog. `nodeVersion` means nothing to them.
   */
  runtimeVersion?: string;
  /**
   * Per-repository SonarCloud key. Tokens and organization are centralized
   * through backend-managed GitHub secrets; this is the only repo-specific
   * Sonar identifier the generated scaffold should carry.
   */
  sonarProjectKey?: string;
  /** Canonical or catalog shape ID ('mono'/'multi' accepted) — defaults to 'standalone' */
  repoShape?: string;
  // Microservices shape only: secondary (frontend) service info
  frontendStack?: string;
  frontendServiceName?: string;
  backendServiceName?: string;
}

// Convert a human-readable service name to a valid npm package name (kebab-case).
function toPackageName(name: string): string {
  return (
    name
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]+/g, '-')
      .replaceAll(/^-+|-+$/g, '') || 'service'
  );
}

// ─── Shared file builders (all stacks) ────────────────────────────────────────

function buildGitignore(): string {
  return [
    'node_modules/',
    'dist/',
    'build/',
    '.env',
    '.env.local',
    '.env.*.local',
    'coverage/',
    '*.log',
    'npm-debug.log*',
    '.DS_Store',
    '.turbo/',
    '.next/',
    'out/',
  ].join('\n');
}

// Pinned dependency ranges. '*' versions made scaffolds non-reproducible and
// broke CI the moment a major release changed behaviour (e.g. ESLint 9 dropped
// --ext and .eslintrc support). Keep these in sync with the lint/test/build
// commands the generated workflows run.
const SCAFFOLD_DEV_DEPENDENCIES: Record<string, string> = {
  typescript: '^5.6.3',
  eslint: '^9.17.0',
  'typescript-eslint': '^8.18.0',
  jest: '^29.7.0',
  'ts-jest': '^29.2.5',
  '@types/jest': '^29.5.14',
  '@types/node': '^22.10.0',
};

function buildPackageJson(packageName: string, stack: string): string {
  const isNextJs = stack === 'nextjs';
  const isNestJs = stack === 'nestjs';

  // Tests live in tests/ (type-checked and linted, never compiled), so
  // compiled stacks build from tsconfig.build.json which includes src only.
  let scripts: Record<string, string>;
  if (isNextJs) {
    scripts = {
      build: 'next build',
      start: 'next start',
      dev: 'next dev',
      test: 'jest',
      typecheck: 'tsc --noEmit',
      lint: 'eslint src tests',
    };
  } else if (isNestJs) {
    scripts = {
      build: 'tsc -p tsconfig.build.json',
      start: 'node dist/main.js',
      dev: 'ts-node src/main.ts',
      test: 'jest',
      typecheck: 'tsc --noEmit',
      lint: 'eslint src tests',
    };
  } else {
    scripts = {
      build: 'tsc -p tsconfig.build.json',
      start: 'node dist/index.js',
      dev: 'ts-node src/index.ts',
      test: 'jest',
      typecheck: 'tsc --noEmit',
      lint: 'eslint src tests',
    };
  }

  const pkg = {
    name: packageName,
    version: '0.1.0',
    // Never published: lets the licence gate skip the app itself (--excludePrivatePackages).
    private: true,
    scripts,
    dependencies: {} as Record<string, string>,
    devDependencies: { ...SCAFFOLD_DEV_DEPENDENCIES } as Record<string, string>,
  };

  if (isNestJs) {
    pkg.dependencies['@nestjs/common'] = '^11.0.0';
    pkg.dependencies['@nestjs/core'] = '^11.0.0';
    pkg.dependencies['@nestjs/platform-express'] = '^11.0.0';
    // Required NestJS peer dependencies — without them tsc cannot resolve
    // the framework's type imports and the build job fails.
    pkg.dependencies['reflect-metadata'] = '^0.2.2';
    pkg.dependencies['rxjs'] = '^7.8.1';
    pkg.devDependencies['@nestjs/testing'] = '^11.0.0';
    pkg.devDependencies['ts-node'] = '^10.9.2';
  }

  if (isNextJs) {
    pkg.dependencies['next'] = '^15.1.0';
    pkg.dependencies['react'] = '^19.0.0';
    pkg.dependencies['react-dom'] = '^19.0.0';
    pkg.devDependencies['@types/react'] = '^19.0.0';
    pkg.devDependencies['@types/react-dom'] = '^19.0.0';
  }

  if (stack === 'react') {
    scripts.build = 'vite build';
    scripts.dev = 'vite --host 0.0.0.0';
    scripts.start = 'vite preview --host 0.0.0.0';
    pkg.dependencies['react'] = '^19.0.0';
    pkg.dependencies['react-dom'] = '^19.0.0';
    pkg.devDependencies['@types/react'] = '^19.0.0';
    pkg.devDependencies['@types/react-dom'] = '^19.0.0';
    pkg.devDependencies['vite'] = '8.3.0';
  }

  if (!isNextJs && !isNestJs) {
    pkg.devDependencies['ts-node'] = '^10.9.2';
  }

  /*
   * The browser suite, for the stacks that render in one.
   *
   * The generated verify stage runs `npm run test:e2e` against the deployed
   * uat URL, and playwright-e2e.yml fails when tests/e2e is absent. Shipping
   * the runner and the script with the scaffold is what keeps that stage
   * green on a project nobody has written a spec for yet - without them a
   * fresh repository goes red at its last stage on the first promotion.
   *
   * Versions come from the shared browser-test dependency constant: the
   * visual checks need @playwright/test >= 1.50 and the accessibility check
   * needs @axe-core/playwright.
   */
  if (isNextJs || stack === 'react') {
    scripts['test:e2e'] = 'playwright test';
    Object.assign(pkg.devDependencies, browserTestDevDependencies());
  }

  return JSON.stringify(pkg, null, 2);
}

// Base tsconfig covers src AND tests so `tsc --noEmit` type-checks the test
// suites. Emit settings (rootDir/outDir) live in tsconfig.build.json so tests
// are never compiled into dist.
function buildTsConfig(stack: string): string {
  const isNextJs = stack === 'nextjs';
  const isReact = stack === 'react';
  const isFrontend = isNextJs || isReact;

  const config = {
    compilerOptions: {
      target: 'ES2022',
      module: isFrontend ? 'ESNext' : 'NodeNext',
      moduleResolution: isFrontend ? 'bundler' : 'NodeNext',
      strict: true,
      ...(isFrontend ? { jsx: 'react-jsx' } : {}),
      lib: isFrontend ? ['ES2022', 'DOM'] : ['ES2022'],
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
    },
    include: ['src', 'tests'],
    exclude: ['node_modules', 'dist'],
  };

  return JSON.stringify(config, null, 2);
}

// Build-only tsconfig for compiled stacks (nestjs/nodejs/react): compiles src
// only so test files never land in dist or the published artifact.
function buildBuildTsConfig(): string {
  return JSON.stringify(
    {
      extends: './tsconfig.json',
      compilerOptions: {
        rootDir: 'src',
        outDir: 'dist',
      },
      include: ['src'],
      exclude: ['node_modules', 'dist'],
    },
    null,
    2,
  );
}

function buildJestConfig(): string {
  return [
    "import type { Config } from 'jest';",
    '',
    'const config: Config = {',
    "  preset: 'ts-jest',",
    "  testEnvironment: 'node',",
    '  testMatch: [',
    "    '**/*.spec.ts',",
    "    '**/*.test.ts',",
    "    '**/*.spec.tsx',",
    "    '**/*.test.tsx',",
    '  ],',
    '  // Browser suites live in tests/e2e and are named *.e2e-spec.ts, which the',
    '  // patterns above already miss. Ignored explicitly as well, so renaming one',
    '  // cannot drag it into the unit runner, where page.goto fails in a way that',
    '  // reads like an application bug rather than a misplaced file.',
    "  testPathIgnorePatterns: ['/node_modules/', '/tests/e2e/'],",
    '  // json-summary is the one that matters: it writes coverage-summary.json,',
    '  // which is the ONLY file the CI coverage gate reads. Jest defaults to',
    '  // clover, json, lcov and text - none of them that - so a suite could pass,',
    '  // write three reports, and still fail the gate with',
    '  // "coverage/coverage-summary.json not found". lcov is kept for SonarCloud',
    '  // and text for the log.',
    "  coverageReporters: ['text', 'lcov', 'json-summary'],",
    "  coverageDirectory: 'coverage',",
    '};',
    '',
    'export default config;',
  ].join('\n');
}

function buildSonarProperties(
  serviceName: string,
  sonarProjectKey?: string,
): string {
  return [
    `sonar.projectKey=${sonarProjectKey ?? serviceName}`,
    `sonar.projectName=${serviceName}`,
    'sonar.sources=src',
    'sonar.tests=src,tests',
    'sonar.test.inclusions=**/*.spec.ts,**/*.test.ts,**/*.spec.tsx,**/*.test.tsx',
    'sonar.typescript.lcov.reportPaths=coverage/lcov.info',
    'sonar.coverage.exclusions=**/*.spec.ts,**/*.test.ts,**/*.spec.tsx,**/*.test.tsx',
  ].join('\n');
}

function buildEntryPoint(serviceName: string): string {
  return [`export const SERVICE_NAME = '${serviceName}';`].join('\n');
}

function buildEntrySpec(serviceName: string, importPath = './index'): string {
  return [
    `import { SERVICE_NAME } from '${importPath}';`,
    '',
    `describe('${serviceName}', () => {`,
    "  it('should export SERVICE_NAME', () => {",
    `    expect(SERVICE_NAME).toBe('${serviceName}');`,
    '  });',
    '});',
  ].join('\n');
}

// README committed inside tests/ so the folder ships with every new repo and
// developers know where each kind of test belongs.
function buildTestsReadme(): string {
  return [
    '# Tests',
    '',
    'This folder is the home for all test suites in this repository.',
    '',
    '| Folder | Purpose |',
    '| ------ | ------- |',
    '| `unit/` | Unit tests. Run by `npm test` and enforced with coverage in CI. |',
    '',
    '## Conventions',
    '',
    '- Unit test files end with `.spec.ts` or `.test.ts` (`.tsx` for React components).',
    '- Mirror the `src/` structure: `src/user/user.service.ts` is tested by `tests/unit/user/user.service.spec.ts`.',
    '- Co-located specs inside `src/` also work, but `tests/unit/` is the checked convention: CI verifies this folder exists.',
    '- When you add end-to-end suites, keep them in `tests/e2e/` and name files `*.e2e-spec.ts` so the unit test runner does not pick them up.',
    '- Frontends start with four browser checks in `tests/e2e/` (pages, links, accessibility, visual). Add routes to `PAGES` in `tests/e2e/support.ts` as the app grows.',
    '',
  ].join('\n');
}

// ESLint 9 flat config — .eslintrc.json and the --ext flag were removed in
// ESLint 9, so the scaffold ships eslint.config.mjs and lints via `eslint src`.
function buildEslintConfig(): string {
  return [
    "import tseslint from 'typescript-eslint';",
    '',
    'export default tseslint.config(',
    "  { ignores: ['dist/', 'coverage/', '.next/', 'out/', 'node_modules/'] },",
    '  ...tseslint.configs.recommended,',
    ');',
    '',
  ].join('\n');
}

// Documents the env vars ALPHACI injects into managed hosting (Render and
// Vercel) at project creation, with sensible local-dev values.
function buildEnvExample(stack: string): string {
  const isFrontend =
    normalizeProjectStack(stack) === 'nextjs' ||
    normalizeProjectStack(stack) === 'react';

  if (isFrontend) {
    return [
      'NODE_ENV=development',
      '',
      '# Backend API base URL. On managed hosting ALPHACI sets this to the',
      '# deployed backend service URL (e.g. https://<service>-uat.onrender.com).',
      'NEXT_PUBLIC_API_URL=http://localhost:4000',
      'API_URL=http://localhost:4000',
    ].join('\n');
  }

  return [
    'NODE_ENV=development',
    'PORT=3000',
    '',
    '# Origins allowed to call this API. On managed hosting ALPHACI sets these',
    '# to the deployed frontend URL(s).',
    'CORS_ORIGINS=http://localhost:3000',
    'FRONTEND_URL=http://localhost:3000',
  ].join('\n');
}

// ─── NestJS-specific files ────────────────────────────────────────────────────

function buildNestAppModule(): string {
  return [
    "import { Module } from '@nestjs/common';",
    '',
    "import { HealthController } from './health.controller.js';",
    '',
    '@Module({ imports: [], controllers: [HealthController], providers: [] })',
    'export class AppModule {}',
  ].join('\n');
}

/**
 * A health endpoint, because the deployment asks for one.
 *
 * ALPHACI health-checks a service after releasing it, and this starter had no
 * routes at all - so every check answered 404 and a service that had started
 * perfectly well reported as a failed deployment, on a repository whose owner
 * had not written any code yet. The path is the one the generated pipeline
 * probes.
 */
function buildNestHealthController(): string {
  return [
    "import { Controller, Get } from '@nestjs/common';",
    '',
    "@Controller('health')",
    'export class HealthController {',
    '  @Get()',
    '  check(): { status: string; uptimeSeconds: number } {',
    "    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };",
    '  }',
    '}',
  ].join('\n');
}

function buildNestHealthControllerSpec(): string {
  return [
    "import { HealthController } from '../../src/health.controller';",
    '',
    "describe('HealthController', () => {",
    "  it('reports the service is up', () => {",
    '    const body = new HealthController().check();',
    '',
    "    expect(body.status).toBe('ok');",
    '    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);',
    '  });',
    '});',
  ].join('\n');
}

function buildNestMain(): string {
  return [
    "import { NestFactory } from '@nestjs/core';",
    "import { AppModule } from './app.module.js';",
    '',
    'async function bootstrap(): Promise<void> {',
    '  const app = await NestFactory.create(AppModule);',
    '  // A browser only lets a frontend on another origin call this API when',
    '  // that origin is listed here. ALPHACI sets CORS_ORIGINS to the deployed',
    "  // frontend's address on managed hosting; a local run falls back to the",
    '  // frontend dev server.',
    '  app.enableCors({',
    "    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000')",
    "      .split(',')",
    '      .map((origin) => origin.trim())',
    '      .filter(Boolean),',
    '  });',
    '  await app.listen(process.env.PORT ?? 3000);',
    '}',
    '',
    'void bootstrap();',
  ].join('\n');
}

// ─── Next.js-specific files ───────────────────────────────────────────────────

function buildNextPage(serviceName: string): string {
  return [
    'export default function Home() {',
    '  return (',
    '    <main>',
    `      <h1>${serviceName}</h1>`,
    '    </main>',
    '  );',
    '}',
  ].join('\n');
}

// next build fails without a root layout in the App Router — it is not
// auto-generated in CI the way `next dev` creates one locally.
function buildNextLayout(serviceName: string): string {
  return [
    "import type { ReactNode } from 'react';",
    '',
    'export const metadata = {',
    `  title: '${serviceName}',`,
    '};',
    '',
    'export default function RootLayout({ children }: { children: ReactNode }) {',
    '  return (',
    '    <html lang="en">',
    '      <body>{children}</body>',
    '    </html>',
    '  );',
    '}',
  ].join('\n');
}

function buildNextConfig(): string {
  return [
    "import type { NextConfig } from 'next';",
    '',
    'const config: NextConfig = {};',
    'export default config;',
  ].join('\n');
}

// ─── React-specific files (plain React, no framework) ────────────────────────
//
// The React starter is intentionally bundler-free: it ships a typed component
// plus a react-dom/server smoke test so lint/test/build/coverage all pass in
// CI (jest stays on testEnvironment 'node') without pinning the customer to
// Vite/CRA. The customer adds their bundler of choice on top.

function buildReactApp(serviceName: string): string {
  return [
    'export interface AppProps {',
    '  title?: string;',
    '}',
    '',
    `export function App({ title = '${serviceName}' }: AppProps) {`,
    '  return (',
    '    <main>',
    '      <h1>{title}</h1>',
    '    </main>',
    '  );',
    '}',
  ].join('\n');
}

function buildReactEntryPoint(): string {
  return [
    "import { StrictMode } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { App } from './App';",
    '',
    "const root = document.getElementById('root');",
    "if (!root) throw new Error('Missing root element');",
    '',
    'createRoot(root).render(',
    '  <StrictMode>',
    '    <App />',
    '  </StrictMode>,',
    ');',
  ].join('\n');
}

function buildReactIndex(serviceName: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `    <title>${serviceName}</title>`,
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    '    <script type="module" src="/src/main.tsx"></script>',
    '  </body>',
    '</html>',
  ].join('\n');
}

function buildReactAppSpec(serviceName: string, importPath = './App'): string {
  return [
    "import { renderToString } from 'react-dom/server';",
    '',
    `import { App } from '${importPath}';`,
    '',
    "describe('App', () => {",
    "  it('renders the default service title', () => {",
    `    expect(renderToString(<App />)).toContain('${serviceName}');`,
    '  });',
    '',
    "  it('renders a custom title', () => {",
    '    expect(renderToString(<App title="custom" />)).toContain(\'custom\');',
    '  });',
    '});',
  ].join('\n');
}

// ─── Docker files ─────────────────────────────────────────────────────────────

function buildDockerfile(nodeVersion: string, stack: string): string {
  // npm ci requires package-lock.json, which the scaffold does not ship (it is
  // generated by the customer's first npm install) — fall back to npm install.
  const entrypoint =
    normalizeProjectStack(stack) === 'nodejs'
      ? 'dist/index.js'
      : 'dist/main.js';

  return [
    `FROM node:${nodeVersion}-alpine AS deps`,
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN if [ -f package-lock.json ]; then npm ci --ignore-scripts; else npm install --ignore-scripts; fi',
    '',
    `FROM node:${nodeVersion}-alpine AS builder`,
    'WORKDIR /app',
    'COPY --from=deps /app/node_modules ./node_modules',
    'COPY . .',
    'RUN npm run build',
    '',
    `FROM node:${nodeVersion}-alpine AS runner`,
    'WORKDIR /app',
    'ENV NODE_ENV=production',
    'ENV PORT=3000',
    // Base image tags lag Alpine security fixes; the release scan blocks
    // fixable HIGH and CRITICAL findings, so take them at build time.
    'RUN apk upgrade --no-cache',
    'RUN addgroup -S nodejs && adduser -S flowci -G nodejs',
    'COPY --from=builder /app/package*.json ./',
    'RUN if [ -f package-lock.json ]; then npm ci --omit=dev --ignore-scripts; else npm install --omit=dev --ignore-scripts; fi',
    'COPY --from=builder --chown=flowci:nodejs /app/dist ./dist',
    'USER flowci',
    'EXPOSE 3000',
    `CMD ["node", "${entrypoint}"]`,
  ].join('\n');
}

function buildDockerignore(): string {
  return [
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.env',
    '.env.*',
    '!.env.example',
    '.git',
    '.github',
    '*.log',
    'npm-debug.log*',
  ].join('\n');
}

function buildReactDockerfile(): string {
  return [
    'FROM node:22.22.2-alpine3.23 AS builder',
    'WORKDIR /app',
    'COPY package.json package-lock.json ./',
    'RUN npm ci',
    'COPY . .',
    'RUN npm run build',
    '',
    'FROM nginxinc/nginx-unprivileged:1.29.4-alpine3.23 AS runner',
    // Base image tags lag Alpine security fixes; the release scan blocks
    // fixable HIGH and CRITICAL findings, so take them at build time.
    'USER root',
    'RUN apk upgrade --no-cache',
    'USER 101',
    'COPY nginx.conf /etc/nginx/conf.d/default.conf',
    'COPY --from=builder /app/dist /usr/share/nginx/html',
    'EXPOSE 8080',
    'HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1',
  ].join('\n');
}

function buildReactNginxConfig(): string {
  return [
    'server {',
    '  listen 8080;',
    '  server_name _;',
    '  root /usr/share/nginx/html;',
    '  index index.html;',
    '',
    '  location / {',
    '    try_files $uri $uri/ /index.html;',
    '  }',
    '}',
  ].join('\n');
}

function buildReactPublishWorkflow(context = '.'): string {
  return [
    'name: Publish React container',
    '',
    'on:',
    '  push:',
    '    branches: [dev, uat, main]',
    '',
    'permissions:',
    '  contents: read',
    '  statuses: read',
    '  packages: write',
    '',
    'jobs:',
    '  check-lockfile:',
    '    runs-on: ubuntu-24.04',
    '    outputs:',
    '      present: ${{ steps.lockfile.outputs.present }}',
    '    steps:',
    '      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2',
    '        with:',
    '          ref: ${{ github.sha }}',
    '      - name: Check for committed dependency lockfile',
    '        id: lockfile',
    '        shell: bash',
    '        run: |',
    `          if [ -f "${context === '.' ? 'package-lock.json' : `${context}/package-lock.json`}" ]; then`,
    '            echo "present=true" >> "$GITHUB_OUTPUT"',
    '          else',
    `            echo "No committed ${context === '.' ? 'package-lock.json' : `${context}/package-lock.json`}; skipping image publication until the reproducible lockfile is committed." >> "$GITHUB_STEP_SUMMARY"`,
    '            echo "present=false" >> "$GITHUB_OUTPUT"',
    '          fi',
    '  quality-gate:',
    "    if: needs.check-lockfile.outputs.present == 'true'",
    '    needs: check-lockfile',
    '    runs-on: ubuntu-24.04',
    '    outputs:',
    '      ready: ${{ steps.quality.outputs.ready }}',
    '    steps:',
    '      - name: Wait for the ALPHACI quality status on this commit',
    '        id: quality',
    '        shell: bash',
    '        env:',
    '          GH_TOKEN: ${{ github.token }}',
    '          GH_REPO: ${{ github.repository }}',
    '          COMMIT_SHA: ${{ github.sha }}',
    '        run: |',
    '          set -euo pipefail',
    '          for attempt in $(seq 1 120); do',
    '            response=$(curl -sf --max-time 15 -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$GH_REPO/commits/$COMMIT_SHA/status")',
    '            state=$(printf \'%s\' "$response" | jq -r \'[.statuses[] | select(.context == "alphaci/quality")] | sort_by(.updated_at) | last | .state // empty\')',
    '            if [ "$state" = "success" ]; then',
    '              echo "ALPHACI quality passed for $COMMIT_SHA."',
    '              echo "ready=true" >> "$GITHUB_OUTPUT"',
    '              exit 0',
    '            fi',
    '            if [ "$state" = "failure" ] || [ "$state" = "error" ]; then',
    '              echo "::error::ALPHACI quality status is $state for $COMMIT_SHA; refusing to publish."',
    '              exit 1',
    '            fi',
    '            sleep 15',
    '          done',
    '          echo "No completed ALPHACI quality run was found for $COMMIT_SHA; image publication is deferred until a later push." >> "$GITHUB_STEP_SUMMARY"',
    '          echo "ready=false" >> "$GITHUB_OUTPUT"',
    '  publish:',
    "    if: needs.quality-gate.outputs.ready == 'true'",
    '    needs: quality-gate',
    '    runs-on: ubuntu-24.04',
    '    steps:',
    '      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2',
    '      - name: Set image name',
    '        id: image',
    '        shell: bash',
    '        run: echo "name=ghcr.io/${GITHUB_REPOSITORY,,}" >> "$GITHUB_OUTPUT"',
    '      - uses: docker/login-action@74a5d142397b4f367a81961eba4e8cd7edddf772 # v3.4.0',
    '        with:',
    '          registry: ghcr.io',
    '          username: ${{ github.actor }}',
    '          password: ${{ secrets.GITHUB_TOKEN }}',
    '      - uses: docker/metadata-action@369eb591f429131d6889c46b94e711f089e6ca96 # v5.6.1',
    '        id: meta',
    '        with:',
    '          images: ${{ steps.image.outputs.name }}',
    '          tags: |',
    '            type=sha,format=long,prefix=candidate-sha-',
    '      - uses: docker/setup-buildx-action@e468171a9de216ec08956ac3ada2f0791b6bd435 # v3.11.1',
    '      - uses: docker/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83 # v6.18.0',
    '        id: build',
    '        with:',
    `          context: ${context}`,
    `          file: ${context === '.' ? 'Dockerfile' : `${context}/Dockerfile`}`,
    '          push: true',
    '          tags: ${{ steps.meta.outputs.tags }}',
    '          labels: |',
    '            ${{ steps.meta.outputs.labels }}',
    '            org.opencontainers.image.revision=${{ github.sha }}',
    '          cache-from: type=gha',
    '          cache-to: type=gha,mode=max',
    '      - name: Scan exact image digest for vulnerabilities',
    '        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0',
    '        with:',
    '          version: v0.74.0',
    '          scan-type: image',
    '          image-ref: ${{ steps.image.outputs.name }}@${{ steps.build.outputs.digest }}',
    '          format: table',
    "          exit-code: '1'",
    '          severity: HIGH,CRITICAL',
    '          vuln-type: os,library',
    '          ignore-unfixed: false',
    '      - name: Record immutable image reference',
    '        shell: bash',
    '        run: |',
    '          echo "Published ${{ steps.image.outputs.name }}@${{ steps.build.outputs.digest }}" >> "$GITHUB_STEP_SUMMARY"',
    '          echo "Source revision: ${GITHUB_SHA}" >> "$GITHUB_STEP_SUMMARY"',
  ].join('\n');
}

// ─── Monorepo-specific helpers ────────────────────────────────────────────────

function buildMonorepoRootPackageJson(packageName: string): string {
  return JSON.stringify(
    {
      name: packageName,
      version: '0.1.0',
      private: true,
      workspaces: ['packages/*'],
      scripts: {
        build: 'tsc -b',
        test: 'jest --passWithNoTests',
        typecheck: 'tsc -p packages/core/tsconfig.json --noEmit',
        lint: 'eslint packages',
      },
      devDependencies: { ...SCAFFOLD_DEV_DEPENDENCIES },
    },
    null,
    2,
  );
}

function buildMonorepoRootTsConfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        composite: true,
        declaration: true,
        declarationMap: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
      },
      // Reference the build config so `tsc -b` compiles src only; the
      // package's tsconfig.json (src + tests) is for typecheck and editors.
      references: [{ path: 'packages/core/tsconfig.build.json' }],
      include: [],
    },
    null,
    2,
  );
}

function buildMonorepoRootJestConfig(): string {
  return [
    "import type { Config } from 'jest';",
    '',
    'const config: Config = {',
    "  projects: ['<rootDir>/packages/*/jest.config.ts'],",
    '};',
    '',
    'export default config;',
  ].join('\n');
}

function buildMonorepoSonarProperties(
  serviceName: string,
  sonarProjectKey?: string,
): string {
  return [
    `sonar.projectKey=${sonarProjectKey ?? serviceName}`,
    `sonar.projectName=${serviceName}`,
    'sonar.sources=packages',
    'sonar.tests=packages',
    'sonar.test.inclusions=**/*.spec.ts,**/*.test.ts,**/*.spec.tsx,**/*.test.tsx',
    'sonar.typescript.lcov.reportPaths=packages/*/coverage/lcov.info',
    'sonar.coverage.exclusions=**/*.spec.ts,**/*.test.ts,**/*.spec.tsx,**/*.test.tsx',
  ].join('\n');
}

// Package typecheck/editor config: covers src AND tests, never emits. The
// root config's composite/declaration flags are switched off here because
// composite projects cannot run with noEmit; tsconfig.build.json re-enables
// them for the actual `tsc -b` build.
function buildPackageTsConfig(): string {
  return JSON.stringify(
    {
      extends: '../../tsconfig.json',
      compilerOptions: {
        composite: false,
        declaration: false,
        declarationMap: false,
        noEmit: true,
      },
      include: ['src', 'tests'],
      exclude: ['node_modules', 'dist'],
    },
    null,
    2,
  );
}

function buildPackageBuildTsConfig(): string {
  return JSON.stringify(
    {
      extends: './tsconfig.json',
      compilerOptions: {
        composite: true,
        declaration: true,
        declarationMap: true,
        noEmit: false,
        rootDir: 'src',
        outDir: 'dist',
      },
      include: ['src'],
      exclude: ['node_modules', 'dist'],
    },
    null,
    2,
  );
}

function buildPackagePackageJson(packageName: string, stack: string): string {
  const pkg = {
    name: packageName,
    version: '0.1.0',
    // Never published: lets the licence gate skip the app itself (--excludePrivatePackages).
    private: true,
    scripts: {
      build: 'tsc -p tsconfig.build.json',
      test: 'jest',
      typecheck: 'tsc --noEmit',
      lint: 'eslint src tests',
    },
    dependencies: {} as Record<string, string>,
    devDependencies: { ...SCAFFOLD_DEV_DEPENDENCIES } as Record<string, string>,
  };

  if (stack === 'nestjs') {
    pkg.dependencies['@nestjs/common'] = '^11.0.0';
    pkg.dependencies['@nestjs/core'] = '^11.0.0';
    pkg.dependencies['@nestjs/platform-express'] = '^11.0.0';
    pkg.dependencies['reflect-metadata'] = '^0.2.2';
    pkg.dependencies['rxjs'] = '^7.8.1';
    pkg.devDependencies['@nestjs/testing'] = '^11.0.0';
  }

  return JSON.stringify(pkg, null, 2);
}

// ─── Microservices-specific helpers ──────────────────────────────────────────

function buildDockerCompose(frontendStack = 'nextjs'): string {
  const frontendContainerPort = frontendStack === 'react' ? '8080' : '3000';
  return [
    'version: "3.9"',
    'services:',
    '  backend:',
    '    build: ./backend',
    '    ports:',
    '      - "3001:3000"',
    '    environment:',
    '      - NODE_ENV=development',
    '  frontend:',
    '    build: ./frontend',
    '    ports:',
    `      - "3000:${frontendContainerPort}"`,
    '    environment:',
    '      - NODE_ENV=development',
    '    depends_on:',
    '      - backend',
  ].join('\n');
}

function buildMicroservicesSonarProperties(
  serviceName: string,
  sonarProjectKey?: string,
): string {
  return [
    `sonar.projectKey=${sonarProjectKey ?? serviceName}`,
    `sonar.projectName=${serviceName}`,
    'sonar.sources=backend/src,frontend/src',
    'sonar.tests=backend/src,frontend/src,backend/tests,frontend/tests',
    'sonar.test.inclusions=**/*.spec.ts,**/*.test.ts,**/*.spec.tsx,**/*.test.tsx',
    'sonar.typescript.lcov.reportPaths=backend/coverage/lcov.info,frontend/coverage/lcov.info',
    'sonar.coverage.exclusions=**/*.spec.ts,**/*.test.ts,**/*.spec.tsx,**/*.test.tsx',
  ].join('\n');
}

// Build scaffold files for a single service under a subdirectory prefix.
function buildServiceSubdirFiles(
  dir: string,
  serviceName: string,
  stack: string,
  nodeVersion: string,
  includeDocker = false,
): ScaffoldFile[] {
  const packageName = toPackageName(serviceName);

  const files: ScaffoldFile[] = [
    {
      path: `${dir}/package.json`,
      content: buildPackageJson(packageName, stack),
    },
    { path: `${dir}/tsconfig.json`, content: buildTsConfig(stack) },
    { path: `${dir}/jest.config.ts`, content: buildJestConfig() },
    { path: `${dir}/eslint.config.mjs`, content: buildEslintConfig() },
    { path: `${dir}/.env.example`, content: buildEnvExample(stack) },
    { path: `${dir}/src/index.ts`, content: buildEntryPoint(serviceName) },
    { path: `${dir}/tests/README.md`, content: buildTestsReadme() },
    {
      path: `${dir}/tests/unit/index.spec.ts`,
      content: buildEntrySpec(serviceName, '../../src/index'),
    },
  ];

  if (stack !== 'nextjs') {
    files.push({
      path: `${dir}/tsconfig.build.json`,
      content: buildBuildTsConfig(),
    });
  }

  if (stack === 'nestjs') {
    files.push(
      { path: `${dir}/src/app.module.ts`, content: buildNestAppModule() },
      {
        path: `${dir}/src/health.controller.ts`,
        content: buildNestHealthController(),
      },
      {
        path: `${dir}/tests/unit/health.controller.spec.ts`,
        content: buildNestHealthControllerSpec(),
      },
      { path: `${dir}/src/main.ts`, content: buildNestMain() },
      {
        path: `${dir}/Dockerfile`,
        content: buildDockerfile(nodeVersion, stack),
      },
      { path: `${dir}/.dockerignore`, content: buildDockerignore() },
    );
  } else if (stack === 'nodejs') {
    files.push(
      {
        path: `${dir}/Dockerfile`,
        content: buildDockerfile(nodeVersion, stack),
      },
      { path: `${dir}/.dockerignore`, content: buildDockerignore() },
    );
  } else if (stack === 'nextjs') {
    files.push(
      {
        path: `${dir}/src/app/layout.tsx`,
        content: buildNextLayout(serviceName),
      },
      { path: `${dir}/src/app/page.tsx`, content: buildNextPage(serviceName) },
      { path: `${dir}/next.config.ts`, content: buildNextConfig() },
      ...buildBrowserTestStarterFiles(`${dir}/`),
    );
  } else if (stack === 'react') {
    files.push(
      { path: `${dir}/src/App.tsx`, content: buildReactApp(serviceName) },
      { path: `${dir}/src/main.tsx`, content: buildReactEntryPoint() },
      { path: `${dir}/index.html`, content: buildReactIndex(serviceName) },
      {
        path: `${dir}/tests/unit/App.spec.tsx`,
        content: buildReactAppSpec(serviceName, '../../src/App'),
      },
      ...buildBrowserTestStarterFiles(`${dir}/`),
    );
    if (includeDocker) {
      files.push(
        { path: `${dir}/Dockerfile`, content: buildReactDockerfile() },
        { path: `${dir}/.dockerignore`, content: buildDockerignore() },
        { path: `${dir}/nginx.conf`, content: buildReactNginxConfig() },
      );
    }
  }

  return files;
}

// ─── Shape-specific scaffold builders ─────────────────────────────────────────

function buildStandaloneScaffold(
  options: BuildScaffoldOptions,
): ScaffoldFile[] {
  const {
    serviceName,
    stack,
    includeDocker,
    nodeVersion = '22',
    runtimeVersion,
    sonarProjectKey,
  } = options;

  // The list below is the Node one despite being called shared: package.json,
  // tsconfig, jest and eslint. A stack on another toolchain builds its own tree
  // rather than adding branches through this function.
  if (stack === 'dotnet') {
    // No sonarProjectKey: .NET gets its key from sonarcloud-dotnet-scan.yml's
    // `/k:` argument, and the properties file that used to carry it is exactly
    // what SonarScanner for .NET refuses to start with.
    return buildDotnetStandaloneScaffold({
      serviceName,
      runtimeVersion: runtimeVersion ?? '10.0.x',
      includeDocker,
    });
  }
  const packageName = toPackageName(serviceName);

  const sharedFiles: ScaffoldFile[] = [
    { path: '.gitignore', content: buildGitignore() },
    { path: 'package.json', content: buildPackageJson(packageName, stack) },
    { path: 'tsconfig.json', content: buildTsConfig(stack) },
    { path: 'jest.config.ts', content: buildJestConfig() },
    {
      path: 'sonar-project.properties',
      content: buildSonarProperties(serviceName, sonarProjectKey),
    },
    { path: 'eslint.config.mjs', content: buildEslintConfig() },
    { path: '.env.example', content: buildEnvExample(stack) },
    { path: 'src/index.ts', content: buildEntryPoint(serviceName) },
    // Dedicated test folder: starter unit spec plus a README documenting the
    // convention, so every repo is born with a place to put tests.
    { path: 'tests/README.md', content: buildTestsReadme() },
    {
      path: 'tests/unit/index.spec.ts',
      content: buildEntrySpec(serviceName, '../../src/index'),
    },
  ];

  // next build compiles via its own pipeline; only tsc-built stacks need the
  // src-only build config.
  if (stack !== 'nextjs') {
    sharedFiles.push({
      path: 'tsconfig.build.json',
      content: buildBuildTsConfig(),
    });
  }

  let stackFiles: ScaffoldFile[];
  if (stack === 'nestjs') {
    stackFiles = [
      { path: 'src/app.module.ts', content: buildNestAppModule() },
      {
        path: 'src/health.controller.ts',
        content: buildNestHealthController(),
      },
      {
        path: 'tests/unit/health.controller.spec.ts',
        content: buildNestHealthControllerSpec(),
      },
      { path: 'src/main.ts', content: buildNestMain() },
    ];
  } else if (stack === 'nextjs') {
    stackFiles = [
      { path: 'src/app/layout.tsx', content: buildNextLayout(serviceName) },
      { path: 'src/app/page.tsx', content: buildNextPage(serviceName) },
      { path: 'next.config.ts', content: buildNextConfig() },
      ...buildBrowserTestStarterFiles(),
    ];
  } else if (stack === 'react') {
    stackFiles = [
      { path: 'src/App.tsx', content: buildReactApp(serviceName) },
      { path: 'src/main.tsx', content: buildReactEntryPoint() },
      { path: 'index.html', content: buildReactIndex(serviceName) },
      {
        path: 'tests/unit/App.spec.tsx',
        content: buildReactAppSpec(serviceName, '../../src/App'),
      },
      ...buildBrowserTestStarterFiles(),
      ...buildBrowserTestStarterFiles(),
      ...(includeDocker
        ? [
            {
              path: '.github/workflows/publish-container.yml',
              content: buildReactPublishWorkflow(),
            },
          ]
        : []),
    ];
  } else {
    stackFiles = [];
  }

  const dockerFiles: ScaffoldFile[] = includeDocker
    ? stack === 'react'
      ? [
          { path: 'Dockerfile', content: buildReactDockerfile() },
          { path: '.dockerignore', content: buildDockerignore() },
          { path: 'nginx.conf', content: buildReactNginxConfig() },
        ]
      : [
          { path: 'Dockerfile', content: buildDockerfile(nodeVersion, stack) },
          { path: '.dockerignore', content: buildDockerignore() },
        ]
    : [];

  return [...sharedFiles, ...stackFiles, ...dockerFiles];
}

function buildMonorepoScaffold(options: BuildScaffoldOptions): ScaffoldFile[] {
  const { serviceName, stack, sonarProjectKey } = options;
  const rootPackageName = toPackageName(serviceName);
  const corePackageName = `@${rootPackageName}/core`;

  return [
    // Root workspace files
    { path: '.gitignore', content: buildGitignore() },
    {
      path: 'package.json',
      content: buildMonorepoRootPackageJson(rootPackageName),
    },
    { path: 'tsconfig.json', content: buildMonorepoRootTsConfig() },
    { path: 'jest.config.ts', content: buildMonorepoRootJestConfig() },
    {
      path: 'sonar-project.properties',
      content: buildMonorepoSonarProperties(serviceName, sonarProjectKey),
    },
    { path: 'eslint.config.mjs', content: buildEslintConfig() },
    { path: '.env.example', content: buildEnvExample(stack) },
    // packages/core — rename or duplicate to add more packages
    {
      path: 'packages/core/package.json',
      content: buildPackagePackageJson(corePackageName, stack),
    },
    { path: 'packages/core/tsconfig.json', content: buildPackageTsConfig() },
    {
      path: 'packages/core/tsconfig.build.json',
      content: buildPackageBuildTsConfig(),
    },
    { path: 'packages/core/jest.config.ts', content: buildJestConfig() },
    {
      path: 'packages/core/src/index.ts',
      content: buildEntryPoint(serviceName),
    },
    { path: 'packages/core/tests/README.md', content: buildTestsReadme() },
    {
      path: 'packages/core/tests/unit/index.spec.ts',
      content: buildEntrySpec(serviceName, '../../src/index'),
    },
  ];
}

function buildMicroservicesScaffold(
  options: BuildScaffoldOptions,
): ScaffoldFile[] {
  const {
    serviceName,
    stack: backendStack,
    nodeVersion = '22',
    frontendStack = 'nextjs',
    frontendServiceName,
    backendServiceName,
    sonarProjectKey,
  } = options;

  const beName = backendServiceName ?? serviceName;
  const feName = frontendServiceName ?? `${serviceName}-fe`;
  const includeDocker =
    options.includeDocker ?? defaultIncludeDocker(backendStack);

  const rootFiles: ScaffoldFile[] = [
    { path: '.gitignore', content: buildGitignore() },
    {
      path: 'sonar-project.properties',
      content: buildMicroservicesSonarProperties(serviceName, sonarProjectKey),
    },
  ];

  if (includeDocker) {
    rootFiles.push({
      path: 'docker-compose.yml',
      content: buildDockerCompose(frontendStack),
    });
  }
  if (includeDocker && frontendStack === 'react') {
    rootFiles.push({
      path: '.github/workflows/publish-frontend-container.yml',
      content: buildReactPublishWorkflow('frontend'),
    });
  }

  return [
    ...rootFiles,
    ...buildServiceSubdirFiles(
      'backend',
      beName,
      backendStack,
      nodeVersion,
      includeDocker,
    ),
    ...buildServiceSubdirFiles(
      'frontend',
      feName,
      frontendStack,
      nodeVersion,
      includeDocker,
    ),
  ];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a default project scaffold for the given shape and stack.
 *
 * Returns an ordered array of { path, content } objects that can be pushed to
 * a GitHub repository one by one using the Contents API.
 *
 * - standalone / multi-repo: flat structure, stack-specific files at root
 * - monorepo: workspace root + packages/core with TypeScript project references
 * - microservices: backend/ and frontend/ subdirectories, optional docker-compose
 */
export function buildProjectScaffold(
  options: BuildScaffoldOptions,
): ScaffoldFile[] {
  const normalizedOptions: BuildScaffoldOptions = {
    ...options,
    stack: normalizeProjectStack(options.stack),
    ...(options.frontendStack
      ? { frontendStack: normalizeProjectStack(options.frontendStack) }
      : {}),
  };

  switch (normalizeRepoShape(normalizedOptions.repoShape)) {
    case 'monorepo':
      return buildMonorepoScaffold(normalizedOptions);
    case 'microservices':
      return buildMicroservicesScaffold(normalizedOptions);
    default:
      return buildStandaloneScaffold(normalizedOptions);
  }
}

/**
 * Determine whether Docker files should be included in the scaffold based on
 * the project stack. Backend stacks and plain React frontends include a
 * container target by default; Next.js frontends remain CDN/edge oriented.
 */
export function defaultIncludeDocker(stack: string): boolean {
  const normalizedStack = normalizeProjectStack(stack);
  return (
    normalizedStack === 'nestjs' ||
    normalizedStack === 'nodejs' ||
    normalizedStack === 'react' ||
    normalizedStack === 'dotnet'
  );
}
