import { LocalCiRunsProvider } from './local-ci-runs.provider';

describe('LocalCiRunsProvider', () => {
  it('maps workflow names to ALPHACI stages', () => {
    const provider = new LocalCiRunsProvider();

    expect(provider.mapWorkflowNameToStage('ALPHACI Access Gate')).toBe(
      'access_gate',
    );
    expect(provider.mapWorkflowNameToStage('ALPHACI Quality')).toBe('quality');
    expect(provider.mapWorkflowNameToStage('ALPHACI Package')).toBe('package');
    expect(provider.mapWorkflowNameToStage('Deploy Render')).toBe(
      'deploy_render',
    );
    expect(provider.mapWorkflowNameToStage('Deploy Vercel')).toBe(
      'deploy_vercel',
    );
    expect(provider.mapWorkflowNameToStage('Custom workflow')).toBe('unknown');
  });

  it('returns an empty run list when fixture mode is disabled', async () => {
    const provider = new LocalCiRunsProvider({ fixtureMode: false });

    await expect(
      provider.listRuns({
        projectId: 'project-1',
        repoFullName: 'tone/orders-api',
        workflowFiles: [],
      }),
    ).resolves.toEqual([]);
  });

  it('returns fixture runs in local mock mode with GitHub links', async () => {
    const provider = new LocalCiRunsProvider({ fixtureMode: true });

    await expect(
      provider.listRuns({
        projectId: 'project-1',
        repoFullName: 'tone/orders-api',
        workflowFiles: [
          {
            name: 'ALPHACI Quality',
            path: '.github/workflows/10-alphaci-quality.yml',
          },
        ],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'local-project-1-quality',
        stage: 'quality',
        workflowName: 'ALPHACI Quality',
        htmlUrl:
          'https://github.com/tone/orders-api/actions/workflows/10-alphaci-quality.yml',
        canRerun: false,
      }),
    ]);
  });
});
