import type { DatabaseService } from '#kernel/db/database.service';
import { ProjectWorkflowSettingsRepository } from './project-workflow-settings.repository';

const makeDatabaseService = (query: jest.Mock) =>
  ({
    query,
  }) as unknown as DatabaseService;

describe('ProjectWorkflowSettingsRepository', () => {
  let query: jest.Mock;
  let repository: ProjectWorkflowSettingsRepository;

  beforeEach(() => {
    query = jest.fn();
    repository = new ProjectWorkflowSettingsRepository(
      makeDatabaseService(query),
    );
  });

  it('finds stored workflow settings by project id', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'settings-1',
          project_id: 'project-1',
          settings_json: {
            nodeVersion: '22',
            coverageThreshold: 90,
          },
          created_by: 'user-1',
          updated_by: 'user-1',
          created_at: '2026-06-12T00:00:00.000Z',
          updated_at: '2026-06-12T00:00:00.000Z',
        },
      ],
    });

    const result = await repository.findByProject('project-1');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM projects.project_workflow_settings'),
      ['project-1'],
    );
    expect(result).toMatchObject({
      id: 'settings-1',
      projectId: 'project-1',
      settings: {
        nodeVersion: '22',
        coverageThreshold: 90,
      },
    });
  });
});
