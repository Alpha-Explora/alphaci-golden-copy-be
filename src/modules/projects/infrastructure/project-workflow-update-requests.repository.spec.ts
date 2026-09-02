import type { DatabaseService } from '#kernel/db/database.service';
import { ProjectWorkflowUpdateRequestsRepository } from './project-workflow-update-requests.repository';

const makeDatabaseService = (query: jest.Mock) =>
  ({
    query,
  }) as unknown as DatabaseService;

describe('ProjectWorkflowUpdateRequestsRepository', () => {
  let query: jest.Mock;
  let repository: ProjectWorkflowUpdateRequestsRepository;

  beforeEach(() => {
    query = jest.fn();
    repository = new ProjectWorkflowUpdateRequestsRepository(
      makeDatabaseService(query),
    );
  });

  it('stores workflow update PR request metadata', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'request-1',
          project_id: 'project-1',
          requested_by: 'user-1',
          branch_name: 'alphaci/workflow-update-20260612000000',
          base_branch: 'main',
          pull_request_number: 42,
          pull_request_url: 'https://github.com/tone/orders-api/pull/42',
          status: 'created',
          settings_json: { nodeVersion: '24' },
          workflow_files_json: [
            { path: '.github/workflows/00-alphaci-access.yml' },
          ],
          created_at: '2026-06-12T00:00:00.000Z',
          updated_at: '2026-06-12T00:00:00.000Z',
        },
      ],
    });

    const result = await repository.createRequest({
      projectId: 'project-1',
      requestedBy: 'user-1',
      branchName: 'alphaci/workflow-update-20260612000000',
      baseBranch: 'main',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://github.com/tone/orders-api/pull/42',
      status: 'created',
      settings: { nodeVersion: '24' },
      workflowFiles: [{ path: '.github/workflows/00-alphaci-access.yml' }],
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        'INSERT INTO projects.project_workflow_update_requests',
      ),
      [
        'project-1',
        'user-1',
        'alphaci/workflow-update-20260612000000',
        'main',
        42,
        'https://github.com/tone/orders-api/pull/42',
        'created',
        JSON.stringify({ nodeVersion: '24' }),
        JSON.stringify([{ path: '.github/workflows/00-alphaci-access.yml' }]),
      ],
    );
    expect(result).toMatchObject({
      id: 'request-1',
      projectId: 'project-1',
      pullRequestNumber: 42,
      status: 'created',
    });
  });
});
