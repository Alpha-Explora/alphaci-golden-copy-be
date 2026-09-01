import { FakeGcpRuntimeAdapter } from './fake-gcp-runtime.adapter';
import { GcpProvisioningExecutor } from './gcp-provisioning.executor';

describe('GcpProvisioningExecutor', () => {
  it('uses the runtime port to ensure the registry and Cloud Run service', async () => {
    const runtime = new FakeGcpRuntimeAdapter();
    const executor = new GcpProvisioningExecutor(runtime);

    await expect(
      executor.execute({
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        deploymentTargetId: 'target-1',
        gcpProjectId: 'alpha-runtime',
        region: 'asia-southeast1',
        artifactRegistryRepository: 'alphaci-images',
        serviceName: 'orders-api',
        imageName:
          'asia-southeast1-docker.pkg.dev/alpha-runtime/alphaci-images/orders:main',
        runtimeServiceAccount: 'orders@alpha-runtime.iam.gserviceaccount.com',
        environment: 'prod',
      }),
    ).resolves.toMatchObject({
      repositoryUri:
        'asia-southeast1-docker.pkg.dev/alpha-runtime/alphaci-images',
      serviceUrl: 'https://orders-api-alpha-runtime.a.run.app',
    });

    expect(runtime.calls.map((call) => call.operation)).toEqual([
      'ensureArtifactRegistry',
      'ensureCloudRunService',
    ]);
  });

  it('completes a claimed job and marks its deployment target provisioned', async () => {
    const runtime = new FakeGcpRuntimeAdapter();
    const jobs = { complete: jest.fn(), fail: jest.fn() };
    const targets = { markProvisioned: jest.fn(), markFailed: jest.fn() };
    const executor = new GcpProvisioningExecutor(
      runtime,
      jobs as never,
      targets as never,
    );

    await executor.executeClaimed({
      id: 'job-1',
      jobType: 'provision_target',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      deploymentTargetId: 'target-1',
      status: 'running',
      payload: {
        gcpProjectId: 'alpha-runtime',
        region: 'asia-southeast1',
        artifactRegistryRepository: 'alphaci-images',
        serviceName: 'orders-api',
        imageName:
          'asia-southeast1-docker.pkg.dev/alpha-runtime/alphaci-images/orders:main',
        runtimeServiceAccount: 'orders@alpha-runtime.iam.gserviceaccount.com',
        environment: 'prod',
      },
    });

    expect(jobs.complete).toHaveBeenCalledWith('job-1');
    expect(targets.markProvisioned).toHaveBeenCalledWith('target-1');
    expect(jobs.fail).not.toHaveBeenCalled();
  });

  it('records a safe failure when claimed runtime work fails', async () => {
    const runtime = {
      ensureArtifactRegistry: jest
        .fn()
        .mockRejectedValue(new Error('token leaked')),
      ensureCloudRunService: jest.fn(),
    };
    const jobs = { complete: jest.fn(), fail: jest.fn() };
    const targets = { markProvisioned: jest.fn(), markFailed: jest.fn() };
    const executor = new GcpProvisioningExecutor(
      runtime,
      jobs as never,
      targets as never,
    );
    const job = {
      id: 'job-2',
      jobType: 'provision_target' as const,
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      deploymentTargetId: 'target-2',
      status: 'running',
      payload: {
        gcpProjectId: 'alpha-runtime',
        region: 'asia-southeast1',
        artifactRegistryRepository: 'alphaci-images',
        serviceName: 'orders-api',
        imageName:
          'asia-southeast1-docker.pkg.dev/alpha-runtime/alphaci/orders:main',
        runtimeServiceAccount: 'orders@alpha-runtime.iam.gserviceaccount.com',
        environment: 'prod',
      },
    };

    await expect(executor.executeClaimed(job)).rejects.toThrow('token leaked');
    expect(jobs.fail).toHaveBeenCalledWith('job-2', {
      code: 'GCP_RUNTIME_OPERATION_FAILED',
      safeMessage: 'GCP runtime provisioning failed',
    });
    expect(targets.markFailed).toHaveBeenCalledWith('target-2', {
      code: 'GCP_RUNTIME_OPERATION_FAILED',
      safeMessage: 'GCP runtime provisioning failed',
    });
  });
});
