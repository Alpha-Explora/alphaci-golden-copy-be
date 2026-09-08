import { PIPELINE_BRANCHES } from '#kernel/config/pipeline-branches';
import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';

import { renderWorkflowFragment } from './render-workflow.fragment';

/**
 * Actions rejects a `secrets:` entry the called workflow does not declare, and
 * rejects it at startup — the whole package stage fails to run, with no job
 * ever starting. The generator was sending RENDER_*_TEST after the flow moved
 * from `test` to `dev`, so every Render deploy on every stack was broken.
 *
 * The names are derived from the branch model now. These tests hold that: the
 * keys must follow the flow, and no retired branch may reappear.
 */
const registry = new WorkflowFragmentRegistry([renderWorkflowFragment]);

function renderDeploySecrets(): Record<string, string> {
  const result = registry.build(
    {
      slot: 'backend',
      provider: 'render',
      deploymentStrategy: 'render_image_pushed',
    } as never,
    'uat',
    { serviceName: 'svc', servicePath: '.', centralWorkflowRef: 'v1' } as never,
  );
  const job = Object.values(result?.jobs ?? {}).find((candidate) =>
    (candidate as { uses?: string }).uses?.includes('render-deploy'),
  ) as { secrets: Record<string, string> } | undefined;

  if (!job) throw new Error('render deploy job was not emitted');
  return job.secrets;
}

describe('render deploy secrets', () => {
  it('passes one secret per branch in the flow', () => {
    const keys = Object.keys(renderDeploySecrets()).sort();
    const expected = PIPELINE_BRANCHES.flatMap((branch) => [
      `RENDER_DEPLOY_HOOK_URL_${branch.toUpperCase()}`,
      `RENDER_HEALTHCHECK_URL_${branch.toUpperCase()}`,
    ]).sort();

    expect(keys).toEqual(expected);
  });

  it('never names a branch outside the flow', () => {
    // 'test' is the one that actually broke. Any retired name would do the same.
    for (const key of Object.keys(renderDeploySecrets())) {
      const suffix = key.split('_').pop()?.toLowerCase();
      expect(PIPELINE_BRANCHES).toContain(suffix);
    }
  });

  it('does not mention the retired test branch', () => {
    expect(Object.keys(renderDeploySecrets()).join(',')).not.toContain('TEST');
  });
});
