import type { GcpDeploymentProviderConfig } from './gcp.provider';
import { GcpProvisioningService } from './gcp-provisioning.service';

describe('GcpProvisioningService', () => {
  const config: GcpDeploymentProviderConfig = {
    enabled: true,
    projectId: 'alpha-runtime',
    region: 'asia-southeast1',
    artifactRegistryRepository: 'alphaci-images',
  };

  it('creates a canonical target and enqueue-only idempotent provisioning job', async () => {
    const targets = {
      createOrGet: jest.fn().mockResolvedValue({
        id: 'target-1',
        cloudRunServiceName: 'orders-api',
      }),
    };
    const jobs = {
      create: jest.fn().mockResolvedValue({
        id: 'job-1',
        status: 'queued',
        payload: {},
      }),
    };
    const service = new GcpProvisioningService(config, targets as never, jobs as never);

    await expect(
      service.enqueue({
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        appSlug: 'orders-api',
        environment: 'prod',
        slot: 'backend',
        imageName:
          'asia-southeast1-docker.pkg.dev/alpha-runtime/alphaci-images/orders:main',
        runtimeServiceAccount:
          'orders@alpha-runtime.iam.gserviceaccount.com',
        deployerServiceAccount:
          'deployer@alpha-runtime.iam.gserviceaccount.com',
      }),
    ).resolves.toEqual({ deploymentTargetId: 'target-1', jobId: 'job-1' });

    expect(targets.createOrGet).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceSlot: 'api',
        gcpProjectId: 'alpha-runtime',
        artifactRegistryRepository: 'alphaci-images',
      }),
    );
    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^gcp-provision-target:target-1:[a-f0-9]{16}$/,
        ),
        deploymentTargetId: 'target-1',
      }),
    );
  });

  it('refuses to enqueue when the GCP provider configuration is disabled', async () => {
    const service = new GcpProvisioningService(
      { ...config, enabled: false },
      { createOrGet: jest.fn() } as never,
      { create: jest.fn() } as never,
    );

    await expect(
      service.enqueue({
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        appSlug: 'orders-api',
        environment: 'prod',
        slot: 'backend',
        imageName: 'image',
        runtimeServiceAccount: 'runtime@example.com',
        deployerServiceAccount: 'deployer@example.com',
      }),
    ).rejects.toThrow('GCP deployments are disabled');
  });

  it('derives a collision-resistant Cloud Run service and desired-state job key', async () => {
    const targets = {
      createOrGet: jest
        .fn()
        .mockResolvedValueOnce({ id: 'target-a' })
        .mockResolvedValueOnce({ id: 'target-b' })
        .mockResolvedValueOnce({ id: 'target-a' }),
    };
    const jobs = {
      create: jest
        .fn()
        .mockResolvedValueOnce({ id: 'job-a' })
        .mockResolvedValueOnce({ id: 'job-b' })
        .mockResolvedValueOnce({ id: 'job-c' }),
    };
    const service = new GcpProvisioningService(config, targets as never, jobs as never);
    const baseInput = {
      projectId: 'project-1',
      appSlug: 'orders-api',
      environment: 'prod' as const,
      slot: 'backend' as const,
      imageName:
        'asia-southeast1-docker.pkg.dev/alpha-runtime/alphaci-images/orders:main',
      runtimeServiceAccount:
        'orders@alpha-runtime.iam.gserviceaccount.com',
      deployerServiceAccount:
        'deployer@alpha-runtime.iam.gserviceaccount.com',
    };

    await service.enqueue({ ...baseInput, workspaceId: 'workspace-a' });
    await service.enqueue({ ...baseInput, workspaceId: 'workspace-b' });
    await service.enqueue({
      ...baseInput,
      workspaceId: 'workspace-a',
      imageName:
        'asia-southeast1-docker.pkg.dev/alpha-runtime/alphaci-images/orders:next',
    });

    const firstTarget = targets.createOrGet.mock.calls[0]?.[0];
    const secondTarget = targets.createOrGet.mock.calls[1]?.[0];
    expect(firstTarget.cloudRunServiceName).not.toEqual(
      secondTarget.cloudRunServiceName,
    );
    expect(firstTarget.cloudRunServiceName).toMatch(/^[a-z][a-z0-9-]{0,62}$/);
    expect(jobs.create.mock.calls[0]?.[0].idempotencyKey).not.toEqual(
      jobs.create.mock.calls[2]?.[0].idempotencyKey,
    );
  });
});
