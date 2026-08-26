import { FakeGcpRuntimeAdapter } from './fake-gcp-runtime.adapter';

describe('FakeGcpRuntimeAdapter', () => {
  it('returns a deterministic Artifact Registry URI without making a network call', async () => {
    const adapter = new FakeGcpRuntimeAdapter();

    await expect(
      adapter.ensureArtifactRegistry({
        gcpProjectId: 'alpha-runtime',
        region: 'asia-southeast1',
        repository: 'alphaci-images',
      }),
    ).resolves.toEqual({
      repositoryUri:
        'asia-southeast1-docker.pkg.dev/alpha-runtime/alphaci-images',
    });
    expect(adapter.calls).toEqual([
      {
        operation: 'ensureArtifactRegistry',
        input: {
          gcpProjectId: 'alpha-runtime',
          region: 'asia-southeast1',
          repository: 'alphaci-images',
        },
      },
    ]);
  });

  it('returns a deterministic Cloud Run endpoint without making a network call', async () => {
    const adapter = new FakeGcpRuntimeAdapter();

    await expect(
      adapter.ensureCloudRunService({
        gcpProjectId: 'alpha-runtime',
        region: 'asia-southeast1',
        serviceName: 'orders-api',
        imageName:
          'asia-southeast1-docker.pkg.dev/alpha-runtime/alphaci/orders:main',
        runtimeServiceAccountEmail:
          'orders@alpha-runtime.iam.gserviceaccount.com',
        labels: {
          workspaceId: 'workspace-1',
          projectId: 'project-1',
          environment: 'prod',
        },
      }),
    ).resolves.toMatchObject({
      serviceUrl: 'https://orders-api-alpha-runtime.a.run.app',
      revision: 'mock-revision',
    });
  });
});
