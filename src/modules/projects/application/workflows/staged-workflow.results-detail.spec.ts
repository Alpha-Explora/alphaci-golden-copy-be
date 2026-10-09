import yaml from 'js-yaml';
import { execFileSync } from 'node:child_process';

import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import { vercelWorkflowFragment } from '#modules/runtime/infrastructure/providers/vercel/vercel-workflow.fragment';

import type { WorkflowTemplate } from '../catalog/catalog.service';
import { buildStagedWorkflowBundle } from './staged-workflow.builder';

/*
 * The per-test detail of the browser suite and the SonarCloud issues reach
 * the report the same way as every other result: by env reference, validated
 * fail-soft in the script, and left out when absent or malformed.
 */

interface Step {
  env?: Record<string, string>;
  run?: string;
}
interface Parsed {
  jobs: Record<string, { steps?: Step[] } | undefined>;
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

function stage(name: 'verify' | 'quality'): Parsed {
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
    bundle.workflowFiles.find((file) => file.stage === name)!.yaml,
  ) as Parsed;
}

function stepWithEnv(parsed: Parsed, key: string): Step | undefined {
  return Object.values(parsed.jobs)
    .flatMap((job) => job?.steps ?? [])
    .find((step) => step.env?.[key] !== undefined);
}

const hasJq = (() => {
  try {
    execFileSync('jq', ['--version']);
    return true;
  } catch {
    return false;
  }
})();
const withJq = hasJq ? it : it.skip;

describe('verify stage: per-test detail', () => {
  const report = () => stepWithEnv(stage('verify'), 'E2E_TOTAL_0');

  it('passes tests-cases through env, one per branch job', () => {
    const env = report()?.env ?? {};
    expect(env['E2E_CASES_0']).toBe(
      '${{ needs.ui-tests-uat.outputs.tests-cases }}',
    );
    expect(env['E2E_CASES_1']).toBe(
      '${{ needs.ui-tests-main.outputs.tests-cases }}',
    );
  });

  it('reads it by reference and merges it as tests.cases, never inlined', () => {
    const run = report()?.run ?? '';
    expect(run).not.toContain('tests-cases');
    expect(run).toContain('E2E_CASES_');
    expect(run).toContain('{cases:$cases}');
    expect(run).toContain(
      `jq -e 'type == "array" and all(.[]; type == "object")'`,
    );
    expect(run).toContain(`jq -c '.[:50]'`);
  });

  withJq.each([
    ['[{"title":"t","status":"passed"}]', '[{"title":"t","status":"passed"}]'],
    ['[]', '[]'],
    ['not json', 'null'],
    ['["a"]', 'null'],
    ['', 'null'],
  ])('fail-soft normalisation of %j', (input, expected) => {
    const cmd = [
      `e2e_cases='${input}'`,
      `if [ -n "$e2e_cases" ] && printf '%s' "$e2e_cases" | jq -e 'type == "array" and all(.[]; type == "object")' >/dev/null 2>&1; then`,
      `  e2e_cases=$(printf '%s' "$e2e_cases" | jq -c '.[:50]')`,
      'else e2e_cases=; fi',
      'printf "%s" "${e2e_cases:-null}"',
    ].join('\n');
    expect(execFileSync('bash', ['-c', cmd]).toString()).toBe(expected);
  });
});

describe('quality stage: SonarCloud issues', () => {
  const report = () => stepWithEnv(stage('quality'), 'SONAR_GATE');

  it('reads the issues output by reference beside the other SonarCloud outputs', () => {
    const env = report()?.env ?? {};
    expect(env['SONAR_ISSUES']).toBe('${{ needs.sonar.outputs.issues }}');
    expect(env['SONAR_MEASURES']).toBe('${{ needs.sonar.outputs.measures }}');
  });

  it('merges a non-empty list of objects as sonar.issues, capped at 20', () => {
    const run = report()?.run ?? '';
    expect(run).toContain(
      `jq -e 'type == "array" and length > 0 and all(.[]; type == "object")'`,
    );
    expect(run).toContain(`'. + {issues:$i[:20]}'`);
  });

  withJq.each([
    ['[{"rule":"r","message":"m"}]', '{"issues":[{"rule":"r","message":"m"}]}'],
    ['[]', '{}'],
    ['oops', '{}'],
  ])('leaves malformed or empty issues out (%j)', (input, expected) => {
    const cmd = [
      'SONAR="{}"',
      `SONAR_ISSUES='${input}'`,
      `if printf '%s' "\${SONAR_ISSUES:-}" | jq -e 'type == "array" and length > 0 and all(.[]; type == "object")' >/dev/null 2>&1; then`,
      `  SONAR=$(printf '%s' "$SONAR" | jq -c --argjson i "$SONAR_ISSUES" '. + {issues:$i[:20]}')`,
      'fi',
      'printf "%s" "$SONAR"',
    ].join('\n');
    expect(execFileSync('bash', ['-c', cmd]).toString()).toBe(expected);
  });
});
