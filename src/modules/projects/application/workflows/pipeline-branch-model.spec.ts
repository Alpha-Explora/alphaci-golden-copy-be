import yaml from 'js-yaml';

import {
  BRANCHES_CREATED_ON_PROVISION,
  DEFAULT_BRANCH,
  PIPELINE_BRANCHES,
  PROTECTED_BRANCHES,
} from '#kernel/config/pipeline-branches';
import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';

import type { WorkflowTemplate } from '../catalog/catalog.service';
import { buildStagedWorkflowBundle } from './staged-workflow.builder';
import type { StagedWorkflowOptions } from './staged-workflow.builder';

/**
 * The branch model has two halves that must agree and neither owns the other:
 * the generator writes branch names into every trigger, and provisioning
 * creates the branches those triggers watch.
 *
 * They did disagree. Provisioning created `develop` while the generated
 * pipelines listened on `dev`, and nothing failed — the dev tier simply never
 * ran, because no workflow watched the branch that existed and the branch every
 * workflow watched was never created. Both halves now derive from one
 * declaration; these tests are what keep that true.
 */

const template = {
  id: 'be-nestjs',
  name: 'Backend NestJS',
  description: 'x',
  iconName: 'server',
  categories: ['backend', 'nestjs'],
  filePatterns: [],
  stack: 'nestjs',
  kind: 'backend',
  runtime: 'node',
  propertiesPath: '/p.json',
  workflowPath: '/w.yml',
} as WorkflowTemplate;

interface TriggerBlock {
  push?: { branches?: string[] };
  pull_request?: { branches?: string[] };
}

function generatedTriggers(): Map<string, TriggerBlock> {
  const bundle = buildStagedWorkflowBundle(
    template,
    {
      serviceName: 'svc',
      servicePath: '.',
      coverageThreshold: 80,
    } as unknown as StagedWorkflowOptions,
    new WorkflowFragmentRegistry([]),
  );

  return new Map(
    bundle.workflowFiles.map((file) => [
      file.path,
      (yaml.load(file.yaml) as { on: TriggerBlock }).on,
    ]),
  );
}

describe('pipeline branch model', () => {
  it('creates every branch the pipeline listens on', () => {
    // The invariant that was broken. Provisioning starts a repository on the
    // default branch and creates the rest, so the two together must cover the
    // whole flow -- a tier nothing creates is a tier that never runs.
    const provisioned = [DEFAULT_BRANCH, ...BRANCHES_CREATED_ON_PROVISION];

    expect([...provisioned].sort()).toEqual([...PIPELINE_BRANCHES].sort());
  });

  it('does not create a branch outside the flow', () => {
    for (const branch of BRANCHES_CREATED_ON_PROVISION) {
      expect(PIPELINE_BRANCHES).toContain(branch);
    }
  });

  it('protects every tier above the one developers push to', () => {
    // dev is deliberately unprotected: requiring a pull request there would
    // make the promotion flow start one step too late.
    expect(PROTECTED_BRANCHES).not.toContain(PIPELINE_BRANCHES[0]);
    expect([...PROTECTED_BRANCHES].sort()).toEqual(
      PIPELINE_BRANCHES.slice(1).sort(),
    );
  });

  it('triggers the gated stages on exactly the pipeline branches', () => {
    const triggers = generatedTriggers();
    const access = triggers.get('.github/workflows/00-alphaci-access.yml');

    expect(access?.push?.branches).toEqual([...PIPELINE_BRANCHES]);
    expect(access?.pull_request?.branches).toEqual([...PIPELINE_BRANCHES]);
  });

  it('triggers the env guard on exactly the pipeline branches', () => {
    // The env guard's check context is what branch protection requires, so a
    // branch it does not run on is a branch whose pull requests can never
    // report the required check.
    const triggers = generatedTriggers();
    const guard = triggers.get('.github/workflows/05-alphaci-env-guard.yml');

    expect(guard?.push?.branches).toEqual([...PIPELINE_BRANCHES]);
    expect(guard?.pull_request?.branches).toEqual([...PIPELINE_BRANCHES]);
  });

  it('runs nothing on a branch outside the flow', () => {
    // A developer's own branch must not start a pipeline. Only the two
    // push-triggered files can, and both are restricted to the flow.
    const triggers = generatedTriggers();

    for (const [path, on] of triggers) {
      for (const event of [on.push, on.pull_request]) {
        if (!event) continue;
        expect(event.branches).toBeDefined();
        expect(event.branches).not.toContain('**');
        for (const branch of event.branches ?? []) {
          expect(PIPELINE_BRANCHES).toContain(branch);
        }
      }
      expect(path).toBeTruthy();
    }
  });
});
