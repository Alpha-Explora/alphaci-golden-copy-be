import { GcpDeploymentTargetsRepository } from './gcp-deployment-targets.repository';

describe('GcpDeploymentTargetsRepository', () => {
  it('creates or returns the canonical GCP deployment target', async () => {
    const databaseService = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            id: 'target-1',
            workspace_id: 'workspace-1',
            project_id: 'project-1',
            app_slug: 'orders-api',
            environment: 'prod',
            service_slot: 'api',
            gcp_project_id: 'alpha-runtime',
            region: 'asia-southeast1',
            artifact_registry_repo: 'alphaci-images',
            cloud_run_service_name: 'orders-api',
            runtime_service_account:
              'orders@alpha-runtime.iam.gserviceaccount.com',
          },
        ],
      }),
    };
    const repository = new GcpDeploymentTargetsRepository(
      databaseService as never,
    );

    await expect(
      repository.createOrGet({
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        appSlug: 'orders-api',
        environment: 'prod',
        serviceSlot: 'api',
        gcpProjectId: 'alpha-runtime',
        region: 'asia-southeast1',
        artifactRegistryRepository: 'alphaci-images',
        imageName:
          'asia-southeast1-docker.pkg.dev/alpha-runtime/alphaci-images/orders:main',
        cloudRunServiceName: 'orders-api',
        runtimeServiceAccount:
          'orders@alpha-runtime.iam.gserviceaccount.com',
        deployerServiceAccount:
          'deployer@alpha-runtime.iam.gserviceaccount.com',
      }),
    ).resolves.toMatchObject({
      id: 'target-1',
      cloudRunServiceName: 'orders-api',
    });

    expect(databaseService.query).toHaveBeenCalledWith(
      expect.stringContaining(
        'INSERT INTO runtime_deployments.deployment_targets',
      ),
      expect.arrayContaining([
        'workspace-1',
        'project-1',
        'orders-api',
        'alpha-runtime',
        'asia-southeast1',
      ]),
    );
  });

  it('records provisioned and safe failed states for a target', async () => {
    const databaseService = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const repository = new GcpDeploymentTargetsRepository(
      databaseService as never,
    );

    await repository.markProvisioned('target-1');
    await repository.markFailed('target-2', {
      code: 'GCP_REQUEST_FAILED',
      safeMessage: 'The GCP request failed',
    });

    expect(databaseService.query.mock.calls[0]?.[0]).toContain(
      "provisioning_status = 'provisioned'",
    );
    expect(databaseService.query.mock.calls[1]?.[1]).toEqual([
      'GCP_REQUEST_FAILED',
      'The GCP request failed',
      'target-2',
    ]);
  });
});
