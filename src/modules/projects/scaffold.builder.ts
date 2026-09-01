// ─── Scaffold builder ─────────────────────────────────────────────────────────
//
// Generates a default project scaffold — an array of { path, content } tuples
// ready to be pushed to a freshly-created GitHub repository. The scaffold gives
// developers a working starting point that is compatible with the ALPHACI CI/CD
// workflows (TypeScript, ESLint, Jest with coverage, SonarQube reporting).
//
// Shape-aware: the scaffold structure varies by repoShape (standalone, monorepo,
// microservices, multi-repo) as well as the technology stack.

export interface ScaffoldFile {
  path: string;
  content: string;
}

export type CanonicalRepoShape =
  | 'standalone'
  | 'monorepo'
  | 'microservices'
  | 'multi-repo';

export type CanonicalStack = 'nestjs' | 'nodejs' | 'nextjs' | 'react';

/**
 * Accept legacy FE/API project type IDs as well as catalog stack keys. Older
 * saved requests and tests still use values like 'nestjs-api' and 'react-app',
 * but the scaffold needs canonical stack names to emit the right file tree.
 */
export function normalizeProjectStack(
  stack: string | null | undefined,
): CanonicalStack {
  const normalized = (stack ?? '').toLowerCase();

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

  return 'nodejs';
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
    pkg.dependencies['react'] = '^19.0.0';
    pkg.dependencies['react-dom'] = '^19.0.0';
    pkg.devDependencies['@types/react'] = '^19.0.0';
    pkg.devDependencies['@types/react-dom'] = '^19.0.0';
  }

  if (!isNextJs && !isNestJs) {
    pkg.devDependencies['ts-node'] = '^10.9.2';
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
    '@Module({ imports: [], controllers: [], providers: [] })',
    'export class AppModule {}',
  ].join('\n');
}

function buildNestMain(): string {
  return [
    "import { NestFactory } from '@nestjs/core';",
    "import { AppModule } from './app.module.js';",
    '',
    'async function bootstrap(): Promise<void> {',
    '  const app = await NestFactory.create(AppModule);',
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

function buildDockerCompose(): string {
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
    '      - "3000:3000"',
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
    );
  } else if (stack === 'react') {
    files.push(
      { path: `${dir}/src/App.tsx`, content: buildReactApp(serviceName) },
      {
        path: `${dir}/tests/unit/App.spec.tsx`,
        content: buildReactAppSpec(serviceName, '../../src/App'),
      },
    );
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
    sonarProjectKey,
  } = options;
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
      { path: 'src/main.ts', content: buildNestMain() },
    ];
  } else if (stack === 'nextjs') {
    stackFiles = [
      { path: 'src/app/layout.tsx', content: buildNextLayout(serviceName) },
      { path: 'src/app/page.tsx', content: buildNextPage(serviceName) },
      { path: 'next.config.ts', content: buildNextConfig() },
    ];
  } else if (stack === 'react') {
    stackFiles = [
      { path: 'src/App.tsx', content: buildReactApp(serviceName) },
      {
        path: 'tests/unit/App.spec.tsx',
        content: buildReactAppSpec(serviceName, '../../src/App'),
      },
    ];
  } else {
    stackFiles = [];
  }

  const dockerFiles: ScaffoldFile[] = includeDocker
    ? [
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

  const rootFiles: ScaffoldFile[] = [
    { path: '.gitignore', content: buildGitignore() },
    {
      path: 'sonar-project.properties',
      content: buildMicroservicesSonarProperties(serviceName, sonarProjectKey),
    },
  ];

  if (options.includeDocker ?? defaultIncludeDocker(backendStack)) {
    rootFiles.push({
      path: 'docker-compose.yml',
      content: buildDockerCompose(),
    });
  }

  return [
    ...rootFiles,
    ...buildServiceSubdirFiles('backend', beName, backendStack, nodeVersion),
    ...buildServiceSubdirFiles('frontend', feName, frontendStack, nodeVersion),
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
 * the project stack. Backend stacks include Docker by default; frontend stacks
 * do not, since they typically deploy to CDN/edge runtimes rather than
 * container registries.
 */
export function defaultIncludeDocker(stack: string): boolean {
  const normalizedStack = normalizeProjectStack(stack);
  return normalizedStack === 'nestjs' || normalizedStack === 'nodejs';
}
