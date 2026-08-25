import { ProvisioningJobsRepository } from './provisioning-jobs.repository';

describe('ProvisioningJobsRepository', () => {
  it('creates an idempotent GCP provisioning job', async () => {
    const databaseService = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            id: 'job-1',
            job_type: 'provision_target',
            idempotency_key: 'workspace-1:project-1:prod',
            workspace_id: 'workspace-1',
            project_id: 'project-1',
            deployment_target_id: null,
            status: 'queued',
            attempt_count: 0,
            max_attempts: 5,
            payload: { serviceName: 'orders-api' },
            created_at: '2026-08-24T00:00:00.000Z',
            updated_at: '2026-08-24T00:00:00.000Z',
          },
        ],
      }),
    };
    const repository = new ProvisioningJobsRepository(databaseService as never);

    await expect(
      repository.create({
        idempotencyKey: 'workspace-1:project-1:prod',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        payload: { serviceName: 'orders-api' },
      }),
    ).resolves.toMatchObject({
      id: 'job-1',
      status: 'queued',
      payload: { serviceName: 'orders-api' },
    });

    expect(databaseService.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO gcp_operations.provisioning_jobs'),
      [
        'provision_target',
        'workspace-1:project-1:prod',
        'workspace-1',
        'project-1',
        null,
        JSON.stringify({ serviceName: 'orders-api' }),
      ],
    );
  });

  it('atomically claims the next queued provisioning job', async () => {
    const databaseService = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            id: 'job-1',
            job_type: 'provision_target',
            workspace_id: 'workspace-1',
            project_id: 'project-1',
            deployment_target_id: 'target-1',
            status: 'running',
            payload: { serviceName: 'orders-api' },
          },
        ],
      }),
    };
    const repository = new ProvisioningJobsRepository(databaseService as never);

    await expect(repository.claimNext('worker-a')).resolves.toMatchObject({
      id: 'job-1',
      status: 'running',
      deploymentTargetId: 'target-1',
    });
    expect(databaseService.query).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE SKIP LOCKED'),
      ['worker-a'],
    );
  });

  it('marks a claimed job complete or retryable failure without exposing raw errors', async () => {
    const databaseService = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const repository = new ProvisioningJobsRepository(databaseService as never);

    await repository.complete('job-1');
    await repository.fail('job-2', {
      code: 'GCP_REQUEST_FAILED',
      safeMessage: 'The GCP request failed',
    });

    expect(databaseService.query.mock.calls[0]?.[0]).toContain(
      "SET status = 'succeeded'",
    );
    expect(databaseService.query.mock.calls[1]?.[0]).toContain(
      "status = CASE WHEN attempt_count >= max_attempts THEN 'dead_letter' ELSE 'queued' END",
    );
    expect(databaseService.query.mock.calls[1]?.[1]).toEqual([
      'GCP_REQUEST_FAILED',
      'The GCP request failed',
      'job-2',
    ]);
  });
});
