import type { DatabaseService } from '#kernel/db/database.service';
import { AuditEventsRepository } from './audit-events.repository';

const makeDatabaseService = (query: jest.Mock) =>
  ({ query }) as unknown as DatabaseService;

describe('AuditEventsRepository', () => {
  let query: jest.Mock;
  let repository: AuditEventsRepository;

  beforeEach(() => {
    query = jest.fn();
    repository = new AuditEventsRepository(makeDatabaseService(query));
  });

  it('creates an audit event with nullable ownership fields', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'event-1',
          workspace_id: null,
          project_id: 'project-1',
          actor_user_id: 'user-1',
          event_code: 'workflow_pr_created',
          message: 'Workflow update PR created',
          metadata_json: '{"pullRequestNumber":42}',
          created_at: '2026-06-14T00:00:00.000Z',
        },
      ],
    });

    await expect(
      repository.create({
        projectId: 'project-1',
        actorUserId: 'user-1',
        eventCode: 'workflow_pr_created',
        message: 'Workflow update PR created',
        metadata: { pullRequestNumber: 42 },
      }),
    ).resolves.toEqual({
      id: 'event-1',
      workspaceId: null,
      projectId: 'project-1',
      actorUserId: 'user-1',
      eventCode: 'workflow_pr_created',
      message: 'Workflow update PR created',
      metadata: { pullRequestNumber: 42 },
      createdAt: '2026-06-14T00:00:00.000Z',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit.audit_events'),
      [
        null,
        'project-1',
        'user-1',
        'workflow_pr_created',
        'Workflow update PR created',
        '{"pullRequestNumber":42}',
      ],
    );
  });

  it('throws when audit event insert does not return a row', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(
      repository.create({
        eventCode: 'workflow_pr_created',
        message: 'Workflow update PR created',
      }),
    ).rejects.toThrow('Audit event insert did not return a row');
  });

  it('lists a repository and its Project events without reading projects.*', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'event-1',
          workspace_id: 'workspace-1',
          project_id: 'project-1',
          actor_user_id: 'user-9',
          actor_login: 'dev-nine',
          event_code: 'drift_detected',
          message: 'Drift detected',
          metadata_json: { severity: 'warning' },
          created_at: '2026-06-14T00:00:00.123456Z',
        },
        {
          id: 'event-2',
          workspace_id: 'workspace-1',
          project_id: null,
          actor_user_id: null,
          actor_login: null,
          event_code: 'qa.requirement.created',
          message: 'QA requirement "Login" created',
          metadata_json: JSON.stringify({ deliveryProjectId: 'dp-1' }),
          created_at: '2026-06-13T00:00:00.000000Z',
        },
      ],
    });

    await expect(
      repository.listForProject({
        projectId: 'project-1',
        deliveryProjectId: 'dp-1',
        limit: 10,
        before: '2026-06-15T00:00:00.000000Z',
      }),
    ).resolves.toEqual([
      {
        id: 'event-1',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        actorUserId: 'user-9',
        actorLogin: 'dev-nine',
        eventCode: 'drift_detected',
        message: 'Drift detected',
        metadata: { severity: 'warning' },
        createdAt: '2026-06-14T00:00:00.123456Z',
        scope: 'repository',
      },
      {
        id: 'event-2',
        workspaceId: 'workspace-1',
        projectId: null,
        actorUserId: null,
        actorLogin: null,
        eventCode: 'qa.requirement.created',
        message: 'QA requirement "Login" created',
        metadata: { deliveryProjectId: 'dp-1' },
        createdAt: '2026-06-13T00:00:00.000000Z',
        scope: 'project',
      },
    ]);
    const [sql, params] = query.mock.calls.at(-1) as [string, unknown[]];
    // No creator filter and no cross-schema join: the projects module has
    // already authorised the caller.
    expect(sql).not.toContain('projects.provisioned_projects');
    expect(sql).not.toContain('user_id =');
    expect(sql).toContain("metadata_json ->> 'deliveryProjectId'");
    expect(params).toEqual([
      'project-1',
      'dp-1',
      '2026-06-15T00:00:00.000000Z',
      10,
    ]);
  });
});
