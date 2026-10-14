import yaml from 'js-yaml';

import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import { vercelWorkflowFragment } from '#modules/runtime/infrastructure/providers/vercel/vercel-workflow.fragment';

import type { WorkflowTemplate } from '../catalog/catalog.service';
import { buildStagedWorkflowBundle } from '../workflows/staged-workflow.builder';
import { readVisualTestingFlag } from './browser-tests.visual-workflow';

const template = {
  id: 'tpl-react',
  name: 'react pipeline',
  description: 'react',
  iconName: 'server',
  categories: ['react'],
  filePatterns: ['**/*.ts'],
  stack: 'react',
  propertiesPath: '/properties.json',
  workflowPath: '/template.yml',
} as WorkflowTemplate;

/** The verify workflow exactly as the builder generates it for a new project. */
function generatedVerifyYaml(): string {
  const bundle = buildStagedWorkflowBundle(
    template,
    {
      templateId: 'fe-react',
      serviceName: 'orders-web',
      deploymentTargets: [
        {
          slot: 'standalone',
          provider: 'vercel',
          deploymentStrategy: 'vercel_ci_pushed',
          secretNames: {
            token: 'VERCEL_TOKEN_STANDALONE',
            orgId: 'VERCEL_ORG_ID_STANDALONE',
            projectId: 'VERCEL_PROJECT_ID_STANDALONE',
          },
        },
      ],
    } as never,
    new WorkflowFragmentRegistry([vercelWorkflowFragment]),
  );
  return bundle.workflowFiles.find((file) => file.stage === 'verify')!.yaml;
}

/**
 * The ui-tests jobs of Alphaexplora-Sandbox/logistics2cicd-fe's uat verify
 * workflow, generated before visual testing existed (trimmed to what matters).
 */
const OLD_VERIFY_YAML = `
name: logistics2cicd-frontend - ALPHACI Verify
jobs:
  ui-tests-uat:
    needs: [pipeline-context, validate-access, resolve-targets]
    if: \${{ (needs.pipeline-context.outputs.branch) == 'uat' }}
    uses: Alpha-Explora/alphaci-workflow/.github/workflows/playwright-e2e.yml@v1
    with:
      working-directory: .
      system-name: logistics2cicd-frontend
      e2e-base-url: https://\${{ needs.resolve-targets.outputs.ui-uat }}
      e2e-tests-directory: tests/e2e
      browser-list: chromium
      run-only-on-branch: '*'
      upload-artifacts: true
    secrets:
      VERCEL_AUTOMATION_BYPASS_SECRET: \${{ secrets.VERCEL_FRONTEND_AUTOMATION_BYPASS_SECRET }}
  ui-tests-main:
    needs: [pipeline-context, validate-access, resolve-targets]
    if: \${{ (needs.pipeline-context.outputs.branch) == 'main' }}
    uses: Alpha-Explora/alphaci-workflow/.github/workflows/playwright-e2e.yml@v1
    with:
      working-directory: .
      system-name: logistics2cicd-frontend
      e2e-base-url: https://\${{ needs.resolve-targets.outputs.ui-main }}
      e2e-tests-directory: tests/e2e
      browser-list: chromium
      run-only-on-branch: '*'
      upload-artifacts: true
    secrets:
      VERCEL_AUTOMATION_BYPASS_SECRET: \${{ secrets.VERCEL_FRONTEND_AUTOMATION_BYPASS_SECRET }}
`;

/** One Playwright job, wired as the builder wires it, with overrides. */
function workflowWith(job: {
  with?: Record<string, unknown>;
  secrets?: unknown;
}): string {
  return yaml.dump({
    jobs: {
      'ui-tests-uat': {
        uses: 'Alpha-Explora/alphaci-workflow/.github/workflows/playwright-e2e.yml@v1',
        with: {
          'visual-baselines': true,
          'alphaci-api-url': 'https://alphaci.example.com',
          ...job.with,
        },
        secrets:
          'secrets' in job
            ? job.secrets
            : { ALPHACI_TOKEN: '${{ secrets.ALPHACI_TOKEN }}' },
      },
    },
  });
}

describe('readVisualTestingFlag', () => {
  it('is true for a workflow the builder generates today', () => {
    expect(readVisualTestingFlag(generatedVerifyYaml())).toBe(true);
  });

  it('is false for a workflow generated before visual testing existed', () => {
    expect(readVisualTestingFlag(OLD_VERIFY_YAML)).toBe(false);
  });

  it('is null when there is no file', () => {
    expect(readVisualTestingFlag(null)).toBeNull();
    expect(readVisualTestingFlag(undefined)).toBeNull();
    expect(readVisualTestingFlag('   \n')).toBeNull();
  });

  it.each([
    ['broken YAML', 'jobs:\n  a: [unclosed\n  b: {'],
    ['a bare string', 'just some words'],
    ['a list', '- a\n- b'],
    ['no jobs map', 'name: x\non: push\n'],
    ['jobs that is not a map', 'jobs: nope'],
  ])('is null for %s', (_label, content) => {
    expect(readVisualTestingFlag(content)).toBeNull();
  });

  it('is false when no job calls the Playwright workflow', () => {
    const content = yaml.dump({
      jobs: {
        lint: { 'runs-on': 'ubuntu-latest', steps: [{ run: 'echo hi' }] },
        k6: { uses: 'org/repo/.github/workflows/k6-load.yml@v1' },
      },
    });
    expect(readVisualTestingFlag(content)).toBe(false);
  });

  it('is true when the token is passed with secrets: inherit', () => {
    expect(readVisualTestingFlag(workflowWith({ secrets: 'inherit' }))).toBe(
      true,
    );
  });

  it('is true for a hand-wired complete job', () => {
    expect(readVisualTestingFlag(workflowWith({}))).toBe(true);
  });

  it('is false without visual-baselines: true', () => {
    expect(
      readVisualTestingFlag(
        workflowWith({ with: { 'visual-baselines': false } }),
      ),
    ).toBe(false);
    // A string is not the boolean the reusable workflow's input expects.
    expect(
      readVisualTestingFlag(
        workflowWith({ with: { 'visual-baselines': 'true' } }),
      ),
    ).toBe(false);
  });

  it('is false with a missing or blank alphaci-api-url', () => {
    expect(
      readVisualTestingFlag(workflowWith({ with: { 'alphaci-api-url': '' } })),
    ).toBe(false);
    expect(
      readVisualTestingFlag(
        workflowWith({ with: { 'alphaci-api-url': undefined } }),
      ),
    ).toBe(false);
  });

  it('is false when the ALPHACI_TOKEN secret is not passed', () => {
    expect(readVisualTestingFlag(workflowWith({ secrets: {} }))).toBe(false);
    expect(
      readVisualTestingFlag(
        workflowWith({ secrets: { VERCEL_AUTOMATION_BYPASS_SECRET: 'x' } }),
      ),
    ).toBe(false);
    expect(readVisualTestingFlag(workflowWith({ secrets: undefined }))).toBe(
      false,
    );
  });

  it('needs EVERY Playwright job to be wired, not just one', () => {
    const complete = yaml.load(workflowWith({})) as {
      jobs: Record<string, unknown>;
    };
    const old = yaml.load(OLD_VERIFY_YAML) as { jobs: Record<string, unknown> };
    const mixed = yaml.dump({
      jobs: { ...complete.jobs, 'ui-tests-main': old.jobs['ui-tests-main'] },
    });
    expect(readVisualTestingFlag(mixed)).toBe(false);
  });
});
