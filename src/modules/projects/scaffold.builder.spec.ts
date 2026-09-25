import {
  buildProjectScaffold,
  normalizeProjectStack,
  normalizeRepoShape,
} from './scaffold.builder';

describe('normalizeRepoShape', () => {
  it('maps catalog IDs to canonical shapes', () => {
    expect(normalizeRepoShape('mono')).toBe('monorepo');
    expect(normalizeRepoShape('multi')).toBe('multi-repo');
  });

  it('passes canonical shapes through unchanged', () => {
    expect(normalizeRepoShape('monorepo')).toBe('monorepo');
    expect(normalizeRepoShape('multi-repo')).toBe('multi-repo');
    expect(normalizeRepoShape('microservices')).toBe('microservices');
    expect(normalizeRepoShape('standalone')).toBe('standalone');
  });

  it('falls back to standalone for unknown or missing shapes', () => {
    expect(normalizeRepoShape(undefined)).toBe('standalone');
    expect(normalizeRepoShape(null)).toBe('standalone');
    expect(normalizeRepoShape('something-else')).toBe('standalone');
  });
});
describe('normalizeProjectStack', () => {
  it('maps catalog stack IDs and legacy project type IDs to canonical stacks', () => {
    expect(normalizeProjectStack('nextjs')).toBe('nextjs');
    expect(normalizeProjectStack('react-app')).toBe('react');
    expect(normalizeProjectStack('nestjs-api')).toBe('nestjs');
    expect(normalizeProjectStack('nodejs-api')).toBe('nodejs');
  });

  // A project with no recorded stack predates the catalog; nodejs is the right
  // answer for it and existing repositories rely on that.
  it('falls back to nodejs when no stack was recorded', () => {
    expect(normalizeProjectStack(undefined)).toBe('nodejs');
    expect(normalizeProjectStack(null)).toBe('nodejs');
    expect(normalizeProjectStack('')).toBe('nodejs');
    expect(normalizeProjectStack('   ')).toBe('nodejs');
  });

  // A stack that was explicitly asked for and is not supported is a different
  // case, and it used to share the fallback above. That is how a request for a
  // stack we cannot scaffold produced a Node repository instead — the caller got
  // a plausible result rather than an error, and only found out when the
  // generated pipeline ran `npm ci` against a project with no lockfile.
  it('rejects a stack that was asked for but cannot be scaffolded', () => {
    expect(() => normalizeProjectStack('python')).toThrow(
      /Unsupported project stack/,
    );
    expect(() => normalizeProjectStack('golang')).toThrow(
      /nextjs, react, nestjs, nodejs or dotnet/,
    );
    expect(() => normalizeProjectStack('unknown')).toThrow();
  });

  it('scaffolds dotnet, which now has a file tree of its own', () => {
    expect(normalizeProjectStack('dotnet')).toBe('dotnet');
  });
});

describe('buildProjectScaffold', () => {
  const baseOptions = {
    serviceName: 'orders-api',
    stack: 'nestjs',
    includeDocker: false,
  };

  /*
   * The verify stage runs `npm run test:e2e` against the deployed uat URL,
   * and playwright-e2e.yml exits 1 when tests/e2e is absent. A frontend
   * scaffold without a browser suite therefore goes red at its last stage on
   * the first promotion, for a project whose code is fine.
   */
  it.each(['react', 'nextjs'])(
    'ships a runnable browser suite for %s',
    (stack) => {
      const files = buildProjectScaffold({
        ...baseOptions,
        stack,
        repoShape: 'standalone',
      });
      const paths = files.map((file) => file.path);

      expect(paths).toContain('playwright.config.ts');
      expect(paths).toContain('tests/e2e/home.e2e-spec.ts');

      const pkg = JSON.parse(
        files.find((file) => file.path === 'package.json')!.content,
      ) as {
        scripts: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      expect(pkg.scripts['test:e2e']).toBe('playwright test');
      expect(pkg.devDependencies['@playwright/test']).toBeDefined();

      // The two runners must not collect each other's files: jest ignores the
      // browser directory, and Playwright only matches the e2e suffix.
      const jestConfig = files.find(
        (file) => file.path === 'jest.config.ts',
      )!.content;
      expect(jestConfig).toContain('/tests/e2e/');
      expect(
        files.find((file) => file.path === 'playwright.config.ts')!.content,
      ).toContain('*.e2e-spec.ts');
    },
  );

  /*
   * A browser suite pointed at a dev server instead of the deployment it was
   * asked about is worse than one that fails, so there is no localhost
   * fallback: an unset base URL stops the run.
   */
  it('refuses to run the browser suite without a deployment URL', () => {
    const files = buildProjectScaffold({
      ...baseOptions,
      stack: 'react',
      repoShape: 'standalone',
    });
    const config = files.find(
      (file) => file.path === 'playwright.config.ts',
    )!.content;

    expect(config).toContain('E2E_BASE_URL');
    expect(config).not.toContain('localhost');
  });

  it("renders the monorepo workspace scaffold for the catalog ID 'mono'", () => {
    const files = buildProjectScaffold({ ...baseOptions, repoShape: 'mono' });
    const paths = files.map((file) => file.path);

    expect(paths).toContain('packages/core/package.json');
    expect(paths).toContain('packages/core/src/index.ts');

    const rootPackage = JSON.parse(
      files.find((file) => file.path === 'package.json')!.content,
    ) as { workspaces?: string[] };
    expect(rootPackage.workspaces).toEqual(['packages/*']);
  });

  it("renders a flat standalone scaffold for the catalog ID 'multi' (one repo per service)", () => {
    const files = buildProjectScaffold({ ...baseOptions, repoShape: 'multi' });
    const paths = files.map((file) => file.path);

    expect(paths).toContain('src/index.ts');
    expect(paths.some((path) => path.startsWith('packages/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('backend/'))).toBe(false);
  });

  it('renders backend/ and frontend/ subdirectories for microservices', () => {
    const files = buildProjectScaffold({
      ...baseOptions,
      repoShape: 'microservices',
      frontendStack: 'nextjs',
      frontendServiceName: 'orders-web',
    });
    const paths = files.map((file) => file.path);

    expect(paths).toContain('backend/package.json');
    expect(paths).toContain('frontend/package.json');
    expect(paths).toContain('frontend/src/app/page.tsx');
  });

  it('uses the repo-specific Sonar project key in standalone scaffolds', () => {
    const files = buildProjectScaffold({
      ...baseOptions,
      sonarProjectKey: 'Alpha-Explora_orders-api',
    });

    const sonar = files.find(
      (file) => file.path === 'sonar-project.properties',
    )!.content;
    expect(sonar).toContain('sonar.projectKey=Alpha-Explora_orders-api');
    expect(sonar).toContain('sonar.projectName=orders-api');
  });

  it('uses the repo-specific Sonar project key in monorepo scaffolds', () => {
    const files = buildProjectScaffold({
      ...baseOptions,
      repoShape: 'mono',
      sonarProjectKey: 'Alpha-Explora_orders-platform',
    });

    const sonar = files.find(
      (file) => file.path === 'sonar-project.properties',
    )!.content;
    expect(sonar).toContain('sonar.projectKey=Alpha-Explora_orders-platform');
    expect(sonar).toContain('sonar.sources=packages');
  });

  it('uses the repo-specific Sonar project key in microservice scaffolds', () => {
    const files = buildProjectScaffold({
      ...baseOptions,
      repoShape: 'microservices',
      frontendStack: 'nextjs',
      sonarProjectKey: 'Alpha-Explora_orders-stack',
    });

    const sonar = files.find(
      (file) => file.path === 'sonar-project.properties',
    )!.content;
    expect(sonar).toContain('sonar.projectKey=Alpha-Explora_orders-stack');
    expect(sonar).toContain('sonar.sources=backend/src,frontend/src');
  });

  it('normalizes legacy NestJS project type IDs before rendering files', () => {
    const files = buildProjectScaffold({
      serviceName: 'orders-api',
      stack: 'nestjs-api',
      includeDocker: true,
    });
    const paths = files.map((file) => file.path);

    expect(paths).toContain('src/main.ts');
    expect(paths).toContain('src/app.module.ts');
    expect(paths).toContain('Dockerfile');
    expect(files.find((file) => file.path === 'Dockerfile')!.content).toContain(
      'CMD ["node", "dist/main.js"]',
    );
  });

  it('lets the deployed frontend call a NestJS API', () => {
    // Provisioning writes the frontend's address into CORS_ORIGINS; without
    // enableCors reading it the browser blocked every call from the frontend.
    const main = buildProjectScaffold({
      serviceName: 'orders-api',
      stack: 'nestjs',
      includeDocker: false,
    }).find((file) => file.path === 'src/main.ts')!.content;

    expect(main).toContain('app.enableCors({');
    expect(main).toContain('process.env.CORS_ORIGINS');
    expect(main.indexOf('app.enableCors(')).toBeLessThan(
      main.indexOf('app.listen('),
    );
  });

  it('uses the Node.js entrypoint in generated Node Dockerfiles', () => {
    const files = buildProjectScaffold({
      serviceName: 'orders-worker',
      stack: 'nodejs',
      includeDocker: true,
    });

    expect(files.map((file) => file.path)).toContain('src/index.ts');
    expect(files.find((file) => file.path === 'Dockerfile')!.content).toContain(
      'CMD ["node", "dist/index.js"]',
    );
  });

  it('renders a real React scaffold for the react stack', () => {
    const files = buildProjectScaffold({
      serviceName: 'orders-web',
      stack: 'react',
      includeDocker: false,
    });
    const paths = files.map((file) => file.path);

    expect(paths).toContain('src/App.tsx');
    expect(paths).toContain('tests/unit/App.spec.tsx');

    const pkg = JSON.parse(
      files.find((file) => file.path === 'package.json')!.content,
    ) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.scripts?.typecheck).toBe('tsc --noEmit');
    expect(pkg.dependencies?.['react']).toBeDefined();
    expect(pkg.dependencies?.['react-dom']).toBeDefined();
    expect(pkg.devDependencies?.['@types/react']).toBeDefined();

    // jest must pick up the .tsx spec or coverage collapses to zero
    const jestConfig = files.find(
      (file) => file.path === 'jest.config.ts',
    )!.content;
    expect(jestConfig).toContain("'**/*.spec.tsx'");

    const app = files.find((file) => file.path === 'src/App.tsx')!.content;
    expect(app).toContain("title = 'orders-web'");
  });

  it('renders a react frontend/ subdirectory for microservices', () => {
    const files = buildProjectScaffold({
      ...baseOptions,
      repoShape: 'microservices',
      frontendStack: 'react',
      frontendServiceName: 'orders-web',
    });
    const paths = files.map((file) => file.path);

    expect(paths).toContain('frontend/src/App.tsx');
    expect(paths).toContain('frontend/tests/unit/App.spec.tsx');
  });

  it('ships a tests/ folder with a starter unit spec in every shape', () => {
    const standalone = buildProjectScaffold(baseOptions).map((f) => f.path);
    expect(standalone).toContain('tests/README.md');
    expect(standalone).toContain('tests/unit/index.spec.ts');
    expect(standalone).not.toContain('src/index.spec.ts');

    const mono = buildProjectScaffold({
      ...baseOptions,
      repoShape: 'mono',
    }).map((f) => f.path);
    expect(mono).toContain('packages/core/tests/README.md');
    expect(mono).toContain('packages/core/tests/unit/index.spec.ts');

    const micro = buildProjectScaffold({
      ...baseOptions,
      repoShape: 'microservices',
      frontendStack: 'nextjs',
    }).map((f) => f.path);
    expect(micro).toContain('backend/tests/unit/index.spec.ts');
    expect(micro).toContain('frontend/tests/unit/index.spec.ts');
    expect(micro).toContain('backend/tests/README.md');
    expect(micro).toContain('frontend/tests/README.md');
  });

  it('keeps starter specs importable and type-checked from tests/unit', () => {
    const files = buildProjectScaffold(baseOptions);

    const spec = files.find(
      (file) => file.path === 'tests/unit/index.spec.ts',
    )!.content;
    expect(spec).toContain("from '../../src/index'");

    const tsconfig = JSON.parse(
      files.find((file) => file.path === 'tsconfig.json')!.content,
    ) as { include?: string[]; compilerOptions?: Record<string, unknown> };
    expect(tsconfig.include).toEqual(['src', 'tests']);
    expect(tsconfig.compilerOptions?.['rootDir']).toBeUndefined();

    // The build config compiles src only so tests never land in dist.
    const buildConfig = JSON.parse(
      files.find((file) => file.path === 'tsconfig.build.json')!.content,
    ) as { include?: string[]; compilerOptions?: Record<string, unknown> };
    expect(buildConfig.include).toEqual(['src']);
    expect(buildConfig.compilerOptions?.['rootDir']).toBe('src');

    const pkg = JSON.parse(
      files.find((file) => file.path === 'package.json')!.content,
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['build']).toBe('tsc -p tsconfig.build.json');
    expect(pkg.scripts?.['lint']).toBe('eslint src tests');

    const sonar = files.find(
      (file) => file.path === 'sonar-project.properties',
    )!.content;
    expect(sonar).toContain('sonar.tests=src,tests');
  });

  it('keeps the Next.js build script free of the tsc build config', () => {
    const files = buildProjectScaffold({
      serviceName: 'orders-web',
      stack: 'nextjs',
      includeDocker: false,
    });
    const paths = files.map((file) => file.path);

    expect(paths).not.toContain('tsconfig.build.json');
    const pkg = JSON.parse(
      files.find((file) => file.path === 'package.json')!.content,
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['build']).toBe('next build');
  });

  it('wires the monorepo build through the package build config', () => {
    const files = buildProjectScaffold({ ...baseOptions, repoShape: 'mono' });
    const paths = files.map((file) => file.path);

    expect(paths).toContain('packages/core/tsconfig.build.json');

    const rootTsConfig = JSON.parse(
      files.find((file) => file.path === 'tsconfig.json')!.content,
    ) as { references?: Array<{ path: string }> };
    expect(rootTsConfig.references).toEqual([
      { path: 'packages/core/tsconfig.build.json' },
    ]);

    // The package typecheck config must not be composite: composite projects
    // cannot run with noEmit, which the root typecheck script relies on.
    const packageTsConfig = JSON.parse(
      files.find((file) => file.path === 'packages/core/tsconfig.json')!
        .content,
    ) as { include?: string[]; compilerOptions?: Record<string, unknown> };
    expect(packageTsConfig.include).toEqual(['src', 'tests']);
    expect(packageTsConfig.compilerOptions?.['composite']).toBe(false);
    expect(packageTsConfig.compilerOptions?.['noEmit']).toBe(true);

    const packageBuildConfig = JSON.parse(
      files.find((file) => file.path === 'packages/core/tsconfig.build.json')!
        .content,
    ) as { include?: string[]; compilerOptions?: Record<string, unknown> };
    expect(packageBuildConfig.include).toEqual(['src']);
    expect(packageBuildConfig.compilerOptions?.['composite']).toBe(true);
    expect(packageBuildConfig.compilerOptions?.['noEmit']).toBe(false);
  });
});
