import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';

import { renderWorkflowFragment } from './render-workflow.fragment';

/**
 * What a Render deploy job is allowed to carry.
 *
 * Two failures live here. Actions rejects a `secrets:` entry the called
 * workflow does not declare, at startup, so the whole package stage failed to
 * run when the generator sent RENDER_*_TEST after the flow moved from `test` to
 * `dev`. And the deploy job used to be handed the platform's Render API key -
 * a credential Render issues per account, not per service - in every customer
 * repository.
 *
 * Both are answered by the same rule: a deploy job carries the project's own
 * AlphaCI token and the address to send it to, and nothing else.
 */
const registry = new WorkflowFragmentRegistry([renderWorkflowFragment]);

function releaseJob(branch: 'dev' | 'uat' | 'main' = 'uat'): {
  uses: string;
  with: Record<string, unknown>;
  secrets: Record<string, string>;
  needs: string[];
} {
  const result = registry.build(
    {
      slot: 'backend',
      provider: 'render',
      deploymentStrategy: 'render_image_pushed',
      imageName: 'alphaci-backend-uat-demo',
    } as never,
    branch,
    { serviceName: 'svc', servicePath: '.', centralWorkflowRef: 'v1' } as never,
  );

  const job = Object.values(result?.jobs ?? {}).find((candidate) =>
    (candidate as { uses?: string }).uses?.includes('release.yml'),
  );

  if (!job) throw new Error('release job was not emitted');
  return job as ReturnType<typeof releaseJob>;
}

describe('render deploy job', () => {
  it('releases through the platform rather than a host-specific workflow', () => {
    expect(releaseJob().uses).toContain('/release.yml@v1');
  });

  it('carries no hosting credential', () => {
    const secrets = releaseJob().secrets;

    expect(Object.keys(secrets).sort()).toEqual([
      'ALPHACI_API_URL',
      'ALPHACI_TOKEN',
    ]);
    // The regression that matters: an account-wide Render key must never be
    // written into a customer repository again.
    expect(JSON.stringify(secrets)).not.toMatch(/RENDER/i);
  });

  it('names the branch and commit from the context job, not the event', () => {
    // A workflow_run stage reads `main` from the git context whichever branch
    // was pushed, so a deploy that trusted it released the wrong branch.
    const job = releaseJob('dev');

    expect(job.with['branch']).toBe('dev');
    expect(job.with['commit-sha']).toBe(
      '${{ needs.pipeline-context.outputs.sha }}',
    );
    expect(job.with['slot']).toBe('backend');
  });

  it('releases the exact build, not whatever the branch tag points at now', () => {
    const job = releaseJob();

    expect(job.with['artifact']).toBe(
      '${{ needs.docker-backend-uat.outputs.image-repo }}:sha-${{ needs.pipeline-context.outputs.sha }}',
    );
    expect(job.needs).toContain('docker-backend-uat');
  });

  it('health-checks the path the generated service exposes', () => {
    expect(releaseJob().with['healthcheck-path']).toBe('/health');
  });
});
