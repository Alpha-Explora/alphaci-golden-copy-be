import yaml from 'js-yaml';

import { ToolchainFragmentRegistry } from '#kernel/ports/toolchain-fragment.port';
import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import type { ToolchainFragmentContext } from '#kernel/ports/toolchain-fragment.port';

import { defaultToolchainRegistry, nodeToolchainFragments } from './index';
import { buildStagedWorkflowBundle } from '../staged-workflow.builder';
import type { StagedWorkflowOptions } from '../staged-workflow.builder';
import type { WorkflowTemplate } from '../../catalog/catalog.service';

/**
 * Every stack the catalog's `inferStack` can return.
 *
 * Kept as a literal list rather than imported, because the point of this test
 * is to fail when the two drift: a stack the catalog can name but no toolchain
 * serves is a project whose quality stage cannot be generated, and the only
 * moment to notice is when the stack is added.
 */
const CATALOG_STACKS = [
  'nextjs',
  'react',
  'nestjs',
  'nodejs',
  'react-native',
  'expo',
  'dotnet',
];

const context: ToolchainFragmentContext = {
  serviceName: 'svc',
  servicePath: 'apps/svc',
  runtimeVersion: '24',
  centralWorkflowRef: 'v1',
  checkoutRef: '${{ github.sha }}',
  hasTestsDirectory: undefined,
  buildBranchCondition: "${{ github.ref_name == 'dev' }}",
  policyJobId: 'branch-policy',
  accessJobId: 'validate-access',
};

describe('toolchain registry', () => {
  it('serves every stack the catalog can produce', () => {
    for (const stack of CATALOG_STACKS) {
      expect(defaultToolchainRegistry.get(stack)).toBeDefined();
    }
  });

  it('fails loudly for a stack no toolchain serves', () => {
    // The whole reason this registry throws where the provider registry returns
    // undefined. A pipeline is allowed to have no deploy target; it is never
    // allowed to have no quality stage, and emitting one anyway is how an
    // unsupported stack produced a green run that tested nothing.
    expect(() => defaultToolchainRegistry.build('rust', context)).toThrow(
      /No toolchain registered for stack 'rust'/,
    );
  });

  it('names the registered stacks when it fails, so the fix is obvious', () => {
    expect(() => defaultToolchainRegistry.build('cobol', context)).toThrow(
      /Registered: .*nestjs/,
    );
  });

  it('rejects a duplicate stack at registration rather than silently winning', () => {
    const registry = new ToolchainFragmentRegistry();
    const fragment = nodeToolchainFragments[0]!;

    registry.register(fragment);
    expect(() => registry.register(fragment)).toThrow(/Duplicate toolchain/);
  });

  it('rejects a fragment with no stack key', () => {
    const registry = new ToolchainFragmentRegistry();

    expect(() =>
      registry.register({ stack: '  ', build: () => ({}) as never }),
    ).toThrow(/non-empty stack/);
  });

  describe('node toolchain', () => {
    it('reports the job that produced coverage, so sonar can wait on it', () => {
      // Sonar consumes the coverage artifact and the producing job is named
      // differently per stack, so a wrong answer here is a Sonar run that
      // uploads nothing rather than a failure.
      expect(defaultToolchainRegistry.build('nestjs', context).testJobId).toBe(
        'backend-tests',
      );
      expect(defaultToolchainRegistry.build('react', context).testJobId).toBe(
        'frontend-tests',
      );
    });

    it('contributes exactly the stack-specific quality jobs', () => {
      const result = defaultToolchainRegistry.build('nextjs', context);

      expect(Object.keys(result.qualityJobs)).toEqual([
        'frontend-tests',
        'lint',
        'typecheck',
        'security',
      ]);
      expect(result.qualityJobIds).toEqual(Object.keys(result.qualityJobs));
    });

    it('passes each test workflow only the inputs it declares', () => {
      // Actions hard-fails a `uses:` carrying an input the callee does not
      // define, so the two shapes cannot be merged into one.
      const backend = defaultToolchainRegistry.build('nodejs', context)
        .qualityJobs['backend-tests'] as { with: Record<string, unknown> };
      const frontend = defaultToolchainRegistry.build('react', context)
        .qualityJobs['frontend-tests'] as { with: Record<string, unknown> };

      expect(backend.with['backend-stack']).toBe('nodejs');
      expect(backend.with).not.toHaveProperty('unit-tests-directory');
      expect(frontend.with['unit-tests-directory']).toBe('src');
      expect(frontend.with).not.toHaveProperty('backend-stack');
    });

    it('widens the unit test path only for scaffolded repositories', () => {
      const scaffolded = defaultToolchainRegistry.build('react', {
        ...context,
        hasTestsDirectory: true,
      }).qualityJobs['frontend-tests'] as { with: Record<string, unknown> };

      expect(scaffolded.with['unit-tests-directory']).toBe('tests/unit');
    });

    it('depends on the policy and access jobs it was given, not on literals', () => {
      const result = defaultToolchainRegistry.build('nestjs', {
        ...context,
        policyJobId: 'policy',
        accessJobId: 'gate',
      });
      const jobs = result.qualityJobs as Record<string, { needs: string[] }>;

      expect(jobs['backend-tests']!.needs).toEqual(['policy']);
      expect(jobs['lint']!.needs).toEqual(['policy']);
      expect(jobs['typecheck']!.needs).toEqual(['policy']);
      // Security is gated on entitlement rather than on branch policy.
      expect(jobs['security']!.needs).toEqual(['gate']);
    });

    it('reads the coverage threshold from the policy job it depends on', () => {
      // The threshold is decided at run time per branch. A fragment that baked
      // in a number would silently disagree with the policy job above it.
      const job = defaultToolchainRegistry.build('nestjs', context).qualityJobs[
        'backend-tests'
      ] as { with: Record<string, unknown> };

      expect(job.with['coverage-threshold']).toBe(
        '${{ fromJson(needs.branch-policy.outputs.coverage-threshold) }}',
      );
    });

    it.each([
      ['nestjs', 'backend-tests'],
      ['react', 'frontend-tests'],
      ['dotnet', 'dotnet-tests'],
    ] as const)(
      'gives the %s test job the promotion threshold from the policy job',
      (stack, jobId) => {
        // Warning-only: dev's test job learns the bar uat and main enforce
        // before a promotion fails on it.
        const job = defaultToolchainRegistry.build(stack, context).qualityJobs[
          jobId
        ] as { with: Record<string, unknown> };

        expect(job.with['promotion-coverage-threshold']).toBe(
          '${{ fromJson(needs.branch-policy.outputs.promotion-coverage-threshold) }}',
        );
      },
    );

    it('pins every reusable workflow to the requested central ref', () => {
      const jobs = defaultToolchainRegistry.build('react', {
        ...context,
        centralWorkflowRef: 'internal-v1',
      }).qualityJobs as Record<string, { uses?: string }>;

      const refs = Object.values(jobs)
        .map((job) => job.uses)
        .filter((uses): uses is string => typeof uses === 'string');

      expect(refs.length).toBeGreaterThan(0);
      for (const uses of refs) {
        expect(uses).toMatch(/@internal-v1$/);
      }
    });
  });

  describe('dotnet toolchain', () => {
    const dotnetContext = { ...context, runtimeVersion: '10.0.x' };

    it('fills the four shared slots, then adds its own', () => {
      // The reporting job waits on whatever ids the fragment declares, so a
      // stack may carry more checks than another. What it may NOT do is rename
      // a shared slot: a stack that called its linter 'dotnet-format' would
      // drop out of the report rather than fail, which is worse than failing.
      const result = defaultToolchainRegistry.build('dotnet', dotnetContext);

      expect(Object.keys(result.qualityJobs)).toEqual([
        'dotnet-tests',
        'lint',
        'typecheck',
        'security',
        'secrets',
        'licenses',
        'sbom',
      ]);
      expect(result.testJobId).toBe('dotnet-tests');
    });

    it('declares every quality job it emits, so none is left unreported', () => {
      // The reporting job's needs come from qualityJobIds. A job present in
      // qualityJobs but missing from the id list still runs and still gates
      // the branch, while its result never reaches the platform — the pipeline
      // would be stricter than the product could explain.
      const result = defaultToolchainRegistry.build('dotnet', dotnetContext);

      expect([...result.qualityJobIds].sort()).toEqual(
        Object.keys(result.qualityJobs).sort(),
      );
    });

    it('calls the .NET workflows, never the Node ones', () => {
      const jobs = defaultToolchainRegistry.build('dotnet', dotnetContext)
        .qualityJobs as Record<string, { uses?: string }>;

      expect(jobs['dotnet-tests']!.uses).toContain('dotnet-test.yml@v1');
      expect(jobs['lint']!.uses).toContain('dotnet-format.yml@v1');
      expect(jobs['typecheck']!.uses).toContain('dotnet-analyze.yml@v1');
      expect(jobs['security']!.uses).toContain('dotnet-audit.yml@v1');

      for (const job of Object.values(jobs)) {
        expect(job.uses).not.toMatch(
          /lint-check|security-scan|backend-tests|frontend-tests/,
        );
      }
    });

    it('passes the SDK version, not a Node major', () => {
      // The generate DTO only carries nodeVersion. Handing that straight to
      // setup-dotnet would ask for an SDK that does not exist.
      const jobs = defaultToolchainRegistry.build('dotnet', dotnetContext)
        .qualityJobs as Record<string, { with: Record<string, unknown> }>;

      // 'secrets' is excluded by name rather than by loosening the rule,
      // because it is the one job here that is not about .NET — see below.
      for (const [id, job] of Object.entries(jobs)) {
        if (id === 'secrets') continue;
        expect(job.with['dotnet-version']).toBe('10.0.x');
        expect(job.with).not.toHaveProperty('node-version');
      }
    });

    it('sends the secret scan no .NET inputs, because it declares none', () => {
      // gitleaks-scan.yml is language-agnostic: a secret in a .cs file and a
      // secret in a .ts file are the same problem. A reusable workflow REJECTS
      // an input it does not declare, so passing the .NET set would fail the
      // call outright — this is a contract, not tidiness.
      const jobs = defaultToolchainRegistry.build('dotnet', dotnetContext)
        .qualityJobs as Record<string, { with: Record<string, unknown> }>;

      expect(jobs['secrets']!.with).not.toHaveProperty('dotnet-version');
      expect(jobs['secrets']!.with).not.toHaveProperty('solution-path');
      expect(jobs['secrets']!.with['system-name']).toBe(context.serviceName);
    });

    it('ties the new gates to the branch policy, not to a constant', () => {
      // Report on the working branch, block before uat and main. Hard-coding
      // true here would block dev on a pre-existing finding, and a gate that
      // blocks the branch people work on gets switched off rather than fixed.
      const jobs = defaultToolchainRegistry.build('dotnet', dotnetContext)
        .qualityJobs as Record<string, { with: Record<string, unknown> }>;

      for (const [id, input] of [
        ['secrets', 'fail-on-findings'],
        ['licenses', 'fail-on-forbidden'],
        ['sbom', 'require-sbom'],
      ] as const) {
        expect(jobs[id]!.with[input]).toContain('outputs.fail-on-warning');
      }
    });

    it('builds with the .NET SDK rather than npm', () => {
      // Every provider deploy job depends on `build`. Before the toolchain
      // owned it, a .NET pipeline would have run npm ci against a repository
      // with no package.json.
      const build = defaultToolchainRegistry.build('dotnet', dotnetContext)
        .packageBuildJob as { steps: { uses?: string; run?: string }[] };

      const runs = build.steps.map((step) => step.run ?? '').join(' ');
      expect(runs).toContain('dotnet publish');
      expect(runs).not.toContain('npm');
      expect(build.steps.some((s) => s.uses?.includes('setup-dotnet'))).toBe(
        true,
      );
      expect(build.steps.some((s) => s.uses?.includes('setup-node'))).toBe(
        false,
      );
    });

    it('takes its strictness from the branch policy like every other stack', () => {
      const jobs = defaultToolchainRegistry.build('dotnet', dotnetContext)
        .qualityJobs as Record<string, { with: Record<string, unknown> }>;
      const expr =
        '${{ fromJson(needs.branch-policy.outputs.fail-on-warning) }}';

      expect(jobs['lint']!.with['fail-on-warning']).toBe(expr);
      expect(jobs['typecheck']!.with['treat-warnings-as-errors']).toBe(expr);
    });
  });
});

describe('runtime version precedence', () => {
  // The create form sends nodeVersion for every stack, Node or not. Reading it
  // ahead of the catalog generated `dotnet-version: 24` and failed every .NET
  // job on an SDK that does not exist.
  const template = {
    id: 'dotnet-service-pipeline',
    name: '.NET',
    description: 'x',
    iconName: 'server',
    categories: ['backend', 'dotnet'],
    filePatterns: [],
    stack: 'dotnet',
    kind: 'backend',
    runtime: 'dotnet',
    runtimeVersion: '10.0.x',
    propertiesPath: '/p.json',
    workflowPath: '/w.yml',
  } as WorkflowTemplate;

  function dotnetVersionIn(nodeVersion: string | undefined): unknown {
    const bundle = buildStagedWorkflowBundle(
      template,
      {
        serviceName: 'svc',
        servicePath: '.',
        coverageThreshold: 80,
        ...(nodeVersion === undefined ? {} : { nodeVersion }),
      } as unknown as StagedWorkflowOptions,
      new WorkflowFragmentRegistry([]),
    );
    const quality = bundle.workflowFiles.find(
      (file) => file.stage === 'quality',
    );
    const doc = yaml.load(quality?.yaml ?? '') as {
      jobs: Record<string, { with?: Record<string, unknown> }>;
    };
    return doc.jobs['dotnet-tests']?.with?.['dotnet-version'];
  }

  it('uses the declared SDK version even when a Node version is sent', () => {
    expect(dotnetVersionIn('24')).toBe('10.0.x');
  });

  it('uses the declared SDK version when nothing is sent', () => {
    expect(dotnetVersionIn(undefined)).toBe('10.0.x');
  });

  it('never emits a node-version input for a .NET job', () => {
    const bundle = buildStagedWorkflowBundle(
      template,
      {
        serviceName: 'svc',
        servicePath: '.',
        coverageThreshold: 80,
        nodeVersion: '24',
      } as unknown as StagedWorkflowOptions,
      new WorkflowFragmentRegistry([]),
    );
    const quality = bundle.workflowFiles.find(
      (file) => file.stage === 'quality',
    );

    expect(quality?.yaml).not.toContain('node-version');
    expect(quality?.yaml).toContain('dotnet-version: 10.0.x');
  });
});

describe('sonar configuration per stack', () => {
  it('sends a Node stack to the generic scanner', () => {
    const sonar = defaultToolchainRegistry.build('nestjs', context).sonar;

    expect(sonar.workflow).toBe('sonarcloud-scan.yml');
    expect(sonar.coverageReportPath).toBe('coverage/lcov.info');
  });

  it('sends a .NET stack to the scanner that can actually analyse C#', () => {
    // The generic sonar-scanner CLI does not support C# at all.
    const sonar = defaultToolchainRegistry.build('dotnet', context).sonar;

    expect(sonar.workflow).toBe('sonarcloud-dotnet-scan.yml');
    expect(sonar.extraWith?.['dotnet-version']).toBe(context.runtimeVersion);
  });

  it('never lets sources and tests overlap', () => {
    // Sonar refuses to index a file as both, and fails the whole scan. This is
    // what aborted the first real .NET run: sources=src with tests=src,tests.
    for (const stack of CATALOG_STACKS) {
      for (const hasTestsDirectory of [undefined, true] as const) {
        const { sonar } = defaultToolchainRegistry.build(stack, {
          ...context,
          hasTestsDirectory,
        });
        const sources = sonar.sourcesPath.split(',').map((p) => p.trim());
        const tests = sonar.testsPath.split(',').map((p) => p.trim());
        const overlap = sources.filter((p) => tests.includes(p));

        // Node is the documented exception: its tests live beside the code and
        // sonar-project.properties separates them by filename.
        if (stack === 'dotnet') {
          expect(overlap).toEqual([]);
        }
        expect(sonar.testsPath).toBeTruthy();
      }
    }
  });

  it('gives .NET disjoint paths', () => {
    const { sonar } = defaultToolchainRegistry.build('dotnet', context);

    expect(sonar.sourcesPath).toBe('src');
    expect(sonar.testsPath).toBe('tests');
  });
});
