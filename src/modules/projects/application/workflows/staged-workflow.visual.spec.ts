import yaml from 'js-yaml';
import { execFileSync } from 'node:child_process';

import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import { vercelWorkflowFragment } from '#modules/runtime/infrastructure/providers/vercel/vercel-workflow.fragment';

import type { WorkflowTemplate } from '../catalog/catalog.service';
import {
  ALPHACI_API_URL,
  BROWSER_TEST_DEPENDENCIES,
  buildStagedWorkflowBundle,
} from './staged-workflow.builder';

interface Step {
  env?: Record<string, string>;
  run?: string;
}
interface Parsed {
  jobs: Record<
    string,
    | {
        with?: Record<string, unknown>;
        secrets?: Record<string, string>;
        steps?: Step[];
      }
    | undefined
  >;
}

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

function verify(): Parsed {
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
  return yaml.load(
    bundle.workflowFiles.find((file) => file.stage === 'verify')!.yaml,
  ) as Parsed;
}

describe('verify stage: visual baselines and confirmed passes', () => {
  it.each(['uat', 'main'] as const)(
    'turns on ALPHACI-stored baselines for the %s browser job',
    (branch) => {
      const job = verify().jobs[`ui-tests-${branch}`];
      expect(job?.with).toMatchObject({
        'visual-baselines': true,
        'alphaci-api-url': ALPHACI_API_URL,
        'visual-branch': branch,
        'ensure-test-deps': BROWSER_TEST_DEPENDENCIES,
      });
      // The token travels as a reusable-call secret, never inside `with:`.
      expect(job?.secrets?.['ALPHACI_TOKEN']).toBe(
        '${{ secrets.ALPHACI_TOKEN }}',
      );
      expect(JSON.stringify(job?.with)).not.toContain('secrets.');
    },
  );

  it('exports one dependency string for the starter pack to share', () => {
    expect(BROWSER_TEST_DEPENDENCIES).toBe(
      '@playwright/test@^1.55.0 @axe-core/playwright@^4.10.0',
    );
  });

  const reportStep = () =>
    (verify().jobs['report-results']?.steps ?? []).find(
      (step) => step.env?.['E2E_TOTAL_0'] !== undefined,
    );

  it('passes the tests-passes outputs through env, one per branch job', () => {
    const env = reportStep()?.env ?? {};
    expect(env['E2E_PASSES_0']).toBe(
      '${{ needs.ui-tests-uat.outputs.tests-passes }}',
    );
    expect(env['E2E_PASSES_1']).toBe(
      '${{ needs.ui-tests-main.outputs.tests-passes }}',
    );
  });

  it('never interpolates the passes into the script body', () => {
    const run = reportStep()?.run ?? '';
    expect(run).not.toContain('tests-passes');
    expect(run).toContain('E2E_PASSES_');
    expect(run).toContain('{passes:$passes}');
  });

  // Run the generated shell fragment's passes handling for real (needs jq).
  const hasJq = (() => {
    try {
      execFileSync('jq', ['--version']);
      return true;
    } catch {
      return false;
    }
  })();
  const maybe = hasJq ? it : it.skip;

  maybe.each([
    ['["a > t","b > u"]', '["a > t","b > u"]'],
    ['[]', '[]'],
    ['not json', 'null'],
    ['', 'null'],
    ['[1,2]', 'null'],
  ])('fail-soft normalisation of %j', (input, expected) => {
    const cmd = [
      `e2e_passes='${input}'`,
      `if [ -n "$e2e_passes" ] && printf '%s' "$e2e_passes" | jq -e 'type == "array" and all(.[]; type == "string")' >/dev/null 2>&1; then`,
      `  e2e_passes=$(printf '%s' "$e2e_passes" | jq -c '[.[:500][] | .[0:500]]')`,
      'else e2e_passes=; fi',
      'printf "%s" "${e2e_passes:-null}"',
    ].join('\n');
    // Guard that the generated script really contains these exact lines.
    const run = reportStep()?.run ?? '';
    expect(run).toContain(
      `jq -e 'type == "array" and all(.[]; type == "string")'`,
    );
    expect(run).toContain(`jq -c '[.[:500][] | .[0:500]]'`);
    expect(execFileSync('bash', ['-c', cmd]).toString()).toBe(expected);
  });
});
