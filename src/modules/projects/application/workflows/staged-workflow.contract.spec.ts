import yaml from 'js-yaml';

import { resolveCentralWorkflowBase } from '#kernel/config/central-workflow';
import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import { renderWorkflowFragment } from '#modules/runtime/infrastructure/providers/render/render-workflow.fragment';
import { vercelWorkflowFragment } from '#modules/runtime/infrastructure/providers/vercel/vercel-workflow.fragment';

import type { WorkflowTemplate } from '../catalog/catalog.service';
import { buildStagedWorkflowBundle } from './staged-workflow.builder';
import type { StagedWorkflowOptions } from './staged-workflow.builder';

/**
 * The set of central workflows this generator depends on.
 *
 * Every entry is a file that must exist in the central workflow repository at
 * the pinned ref. A `uses:` naming a workflow that is not there fails at run
 * time, in the customer's repository, where we do not see it — the workflow
 * repository's own CI carries a matching list, but that list is maintained by
 * hand and has already been wrong once (promotion.yml was missing from it).
 *
 * This assertion is the version that cannot drift: it is derived from what the
 * generator actually emits rather than from anyone remembering to update a list
 * in another repository. Adding a `uses:` here fails this test, and fixing it is
 * the moment to add the workflow on the other side.
 */
const EXPECTED_CENTRAL_WORKFLOWS = [
  'backend-tests.yml',
  // The verify stage. Emitted only for a stack that declares an API suite and
  // has somewhere deployed to run it against — .NET with a Render target.
  'bruno-api-test.yml',
  'docker-build.yml',
  'dotnet-analyze.yml',
  'dotnet-audit.yml',
  'dotnet-format.yml',
  'dotnet-license-scan.yml',
  'dotnet-sbom.yml',
  'dotnet-test.yml',
  'frontend-tests.yml',
  'gitleaks-scan.yml',
  'lint-check.yml',
  'production-gate.yml',
  'promotion.yml',
  'render-deploy.yml',
  'security-scan.yml',
  'sonarcloud-dotnet-scan.yml',
  'sonarcloud-scan.yml',
  'vercel-deploy.yml',
];

const ALL_STACKS: WorkflowTemplate['stack'][] = [
  'nextjs',
  'react',
  'nestjs',
  'nodejs',
  'react-native',
  'expo',
  /*
   * .NET was missing from this list, and it is the stack with the most
   * stack-specific `uses:` of any of them — six workflows no other stack
   * references. The guard that exists to catch a `uses:` pointing at a file
   * that is not there was not looking at the one place it was most likely to
   * happen.
   */
  'dotnet',
];

const makeTemplate = (stack: WorkflowTemplate['stack']): WorkflowTemplate => ({
  id: `tpl-${stack}`,
  name: `${stack} pipeline`,
  description: `${stack} service pipeline`,
  iconName: 'server',
  categories: [stack],
  filePatterns: ['**/*.ts'],
  stack,
  propertiesPath: '/properties.json',
  workflowPath: '/template.yml',
});

interface ParsedWorkflow {
  jobs: Record<string, { uses?: string } | undefined>;
}

function centralWorkflowsIn(yamlText: string): string[] {
  const parsed = yaml.load(yamlText) as ParsedWorkflow;
  const base = `${resolveCentralWorkflowBase()}/`;

  return Object.values(parsed.jobs ?? {})
    .map((job) => job?.uses)
    .filter((uses): uses is string => typeof uses === 'string')
    .filter((uses) => uses.startsWith(base))
    .map((uses) => uses.slice(base.length).split('@')[0]!);
}

describe('staged workflow generator: central workflow contract', () => {
  const registry = new WorkflowFragmentRegistry([
    renderWorkflowFragment,
    vercelWorkflowFragment,
  ]);

  // Every stack, with and without each provider, so a workflow reachable only
  // through one combination still shows up in the collected set.
  function collectEveryEmittedWorkflow(): string[] {
    const emitted = new Set<string>();

    const targetSets: NonNullable<
      StagedWorkflowOptions['deploymentTargets']
    >[] = [
      [],
      [
        {
          slot: 'backend',
          provider: 'render',
          branchName: 'uat',
          deploymentStrategy: 'render_image_pushed',
          dockerContext: '.',
          dockerfilePath: 'Dockerfile',
          imageName: 'alphaci-backend',
          secretNames: {
            deployHookUrl: 'RENDER_DEPLOY_HOOK_URL_UAT',
            healthcheckUrl: 'RENDER_HEALTHCHECK_URL_UAT',
          },
        },
      ],
      [
        {
          slot: 'frontend',
          provider: 'vercel',
          branchName: 'main',
          deploymentStrategy: 'vercel_git',
          secretNames: {
            token: 'VERCEL_TOKEN',
            orgId: 'VERCEL_ORG_ID',
            projectId: 'VERCEL_PROJECT_ID',
          },
        },
      ],
    ];

    for (const stack of ALL_STACKS) {
      for (const deploymentTargets of targetSets) {
        const bundle = buildStagedWorkflowBundle(
          makeTemplate(stack),
          {
            templateId: `tpl-${stack}`,
            serviceName: 'orders-api',
            ...(deploymentTargets.length > 0 && { deploymentTargets }),
          },
          registry,
        );

        for (const file of bundle.workflowFiles) {
          for (const workflow of centralWorkflowsIn(file.yaml)) {
            emitted.add(workflow);
          }
        }
      }
    }

    return [...emitted].sort();
  }

  it('emits uses: for exactly the central workflows we expect to exist', () => {
    expect(collectEveryEmittedWorkflow()).toEqual(EXPECTED_CENTRAL_WORKFLOWS);
  });

  it('builds every uses: from the configured repository, never a literal', () => {
    const base = resolveCentralWorkflowBase();
    const bundle = buildStagedWorkflowBundle(
      makeTemplate('nestjs'),
      { templateId: 'tpl-nestjs', serviceName: 'orders-api' },
      registry,
    );

    const allUses = bundle.workflowFiles.flatMap((file) =>
      Object.values((yaml.load(file.yaml) as ParsedWorkflow).jobs ?? {})
        .map((job) => job?.uses)
        .filter((uses): uses is string => typeof uses === 'string'),
    );

    // Third-party actions are called as `owner/repo@ref` steps, not as jobs, so
    // every job-level `uses:` in a generated pipeline should be one of ours.
    expect(allUses.length).toBeGreaterThan(0);
    for (const uses of allUses) {
      expect(uses.startsWith(`${base}/`)).toBe(true);
    }
  });

  // ── Known gap ──────────────────────────────────────────────────────────────
  // GCP is a registered deployment provider (gcp.provider.ts, slots backend /
  // frontend / standalone) and gcp-cloud-run-deploy.yml exists in the central
  // repository — but no workflow fragment is registered for it. The builder
  // skips targets whose provider has no fragment (`if (!fragment) continue`),
  // so a project configured to deploy to Cloud Run generates a pipeline with no
  // deploy job and no error.
  //
  // This is asserted rather than omitted so the gap is recorded in executable
  // form. When the fragment is added this test fails, which is the prompt to add
  // gcp-cloud-run-deploy.yml to EXPECTED_CENTRAL_WORKFLOWS above.
  it('has no GCP workflow fragment — known gap, deploy jobs are silently skipped', () => {
    expect(registry.get('render')).toBeDefined();
    expect(registry.get('vercel')).toBeDefined();
    expect(registry.get('gcp')).toBeUndefined();

    expect(EXPECTED_CENTRAL_WORKFLOWS).not.toContain(
      'gcp-cloud-run-deploy.yml',
    );
  });
});
