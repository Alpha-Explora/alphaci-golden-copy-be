import {
  buildProjectScaffold,
  normalizeProjectStack,
  normalizeRepoShape,
} from './scaffold.builder';
import {
  BROWSER_TEST_REQUIRED_PATHS,
  SNAPSHOT_PATH_TEMPLATE,
} from './scaffolds/browser-test-starter';

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
  it.each(['react', 'nextjs', 'node'])(
    'marks the %s package private so the licence gate skips the app itself',
    (stack) => {
      const files = buildProjectScaffold({
        ...baseOptions,
        stack,
        repoShape: 'standalone',
      });
      const pkg = JSON.parse(
        files.find((file) => file.path === 'package.json')!.content,
      ) as { private?: boolean; license?: string };
      expect(pkg.private).toBe(true);
      expect(pkg.license).toBeUndefined();
    },
  );

  /*
   * A fresh Next.js repository failed its first quality gate three ways:
   * jest.config.ts could not load without ts-node, Jest 29 pulled a braces
   * release with a HIGH advisory into the audit, and the visual test's
   * mask(_page) hook tripped no-unused-vars.
   */
  it.each(['react', 'nextjs', 'nestjs', 'node'])(
    'gives %s what its own quality gate needs',
    (stack) => {
      const files = buildProjectScaffold({
        ...baseOptions,
        stack,
        repoShape: 'standalone',
      });
      const pkg = JSON.parse(
        files.find((file) => file.path === 'package.json')!.content,
      ) as { devDependencies: Record<string, string> };
      expect(pkg.devDependencies['ts-node']).toBe('^10.9.2');
      expect(pkg.devDependencies['jest']).toBe('^30.0.0');
      expect(pkg.devDependencies['ts-jest']).toBe('^29.4.0');
      expect(pkg.devDependencies['@types/jest']).toBe('^30.0.0');

      const eslint = files.find(
        (file) => file.path === 'eslint.config.mjs',
      )!.content;
      expect(eslint).toContain("argsIgnorePattern: '^_'");
      expect(eslint).toContain("varsIgnorePattern: '^_'");
    },
  );

  it('overrides the postcss Next.js pins so the audit passes', () => {
    const pkgOf = (stack: string) =>
      JSON.parse(
        buildProjectScaffold({
          ...baseOptions,
          stack,
          repoShape: 'standalone',
        }).find((file) => file.path === 'package.json')!.content,
      ) as { overrides?: Record<string, string> };
    expect(pkgOf('nextjs').overrides).toEqual({ postcss: '^8.5.30' });
    expect(pkgOf('nestjs').overrides).toBeUndefined();
  });

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
      for (const spec of BROWSER_TEST_REQUIRED_PATHS) {
        expect(paths).toContain(spec);
      }
      expect(paths).not.toContain('tests/e2e/home.e2e-spec.ts');

      const pkg = JSON.parse(
        files.find((file) => file.path === 'package.json')!.content,
      ) as {
        scripts: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      expect(pkg.scripts['test:e2e']).toBe('playwright test');
      expect(pkg.devDependencies['@playwright/test']).toBe('^1.55.0');
      expect(pkg.devDependencies['@axe-core/playwright']).toBe('^4.10.0');

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

  /*
   * A uat/main preview sits behind Vercel's Standard Protection, which sends
   * Playwright the same 302-to-SSO every other unauthenticated caller gets.
   * playwright-e2e.yml only ever sets this env var when a Vercel frontend
   * target actually installed the bypass secret, so its absence (no Vercel
   * target, or one provisioned before this existed) must run the suite
   * exactly as before rather than send an empty header.
   */
  it('sends the Vercel automation bypass header only when the secret is provided', () => {
    const files = buildProjectScaffold({
      ...baseOptions,
      stack: 'react',
      repoShape: 'standalone',
    });
    const config = files.find(
      (file) => file.path === 'playwright.config.ts',
    )!.content;

    expect(config).toContain('VERCEL_AUTOMATION_BYPASS_SECRET');
    expect(config).toContain('x-vercel-protection-bypass');
    expect(config).toContain('x-vercel-set-bypass-cookie');
  });

  /*
   * playwright-e2e.yml downloads approved baselines into
   * tests/e2e/__visual__/<name>.png, flat. A config with any other template
   * would store (and look for) screenshots somewhere the workflow never
   * places them, so every visual check would re-record instead of compare.
   */
  it('stores screenshots flat, where the verify workflow puts baselines', () => {
    const files = buildProjectScaffold({
      ...baseOptions,
      stack: 'nextjs',
      repoShape: 'standalone',
    });
    const config = files.find(
      (file) => file.path === 'playwright.config.ts',
    )!.content;

    expect(SNAPSHOT_PATH_TEMPLATE).toBe('{testDir}/__visual__/{arg}{ext}');
    expect(config).toContain(
      "snapshotPathTemplate: '{testDir}/__visual__/{arg}{ext}'",
    );
    expect(config).toContain('maxDiffPixelRatio: 0.001');
    expect(config).toContain("name: 'chromium'");
  });

  it('ships the four checks, sharing PAGES instead of repeating it', () => {
    const files = buildProjectScaffold({
      ...baseOptions,
      stack: 'react',
      repoShape: 'standalone',
    });
    const content = (path: string): string =>
      files.find((file) => file.path === path)!.content;

    expect(content('tests/e2e/support.ts')).toContain(
      "export const PAGES: string[] = ['/'];",
    );
    expect(content('tests/e2e/pages.e2e-spec.ts')).toContain(
      "import { PAGES, collectPageProblems } from './support';",
    );
    expect(content('tests/e2e/support.ts')).toContain("'pageerror'");
    expect(content('tests/e2e/support.ts')).toContain('favicon');
    expect(content('tests/e2e/links.e2e-spec.ts')).toContain('MAX_LINKS = 25');
    expect(content('tests/e2e/links.e2e-spec.ts')).toContain(
      'mailto|tel|javascript',
    );
    // A page with no same-site links must skip, not pass, and a capped run
    // must say it was capped.
    const links = content('tests/e2e/links.e2e-spec.ts');
    expect(links).toContain('if (targets.length === 0) {');
    expect(links).toContain(
      "'No same-site links on the home page, so nothing was checked'",
    );
    expect(links).toContain('test.skip(true, reason);');
    expect(links).toContain(
      "(targets.length > checked.length ? 'first ' : '')",
    );
    expect(links).toContain('(capped at ');
    expect(content('tests/e2e/a11y.e2e-spec.ts')).toContain(
      "from '@axe-core/playwright'",
    );
    expect(content('tests/e2e/a11y.e2e-spec.ts')).toContain(
      "['critical', 'serious']",
    );
    const visual = content('tests/e2e/visual.e2e-spec.ts');
    expect(visual).toContain('width: 1280, height: 800');
    expect(visual).toContain('width: 390, height: 844');
    expect(visual).toContain("'home-' + name + '.png'");
    expect(visual).toContain('fullPage: true');
    expect(visual).toContain("animations: 'disabled'");
  });

  it('keeps non-frontend stacks free of the browser pack', () => {
    const files = buildProjectScaffold({
      ...baseOptions,
      stack: 'nestjs',
      repoShape: 'standalone',
    });
    expect(files.map((file) => file.path)).not.toContain(
      'tests/e2e/pages.e2e-spec.ts',
    );
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

  // The Node runner copied dist/, which a Next.js build never writes, so the
  // first image build of every Next.js project failed at that COPY.
  it('serves Next.js images with next start from .next', () => {
    const files = buildProjectScaffold({
      serviceName: 'storefront',
      stack: 'nextjs',
      includeDocker: true,
    });
    const dockerfile = files.find(
      (file) => file.path === 'Dockerfile',
    )!.content;

    expect(dockerfile).not.toContain('/app/dist');
    expect(dockerfile).toContain(
      'COPY --from=builder --chown=flowci:nodejs /app/.next ./.next',
    );
    expect(dockerfile).toContain(
      'COPY --from=builder /app/node_modules/typescript ./node_modules/typescript',
    );
    expect(dockerfile).toContain(
      'CMD ["node", "node_modules/next/dist/bin/next", "start"]',
    );
    expect(
      files.find((file) => file.path === '.dockerignore')!.content,
    ).toContain('.next');
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
