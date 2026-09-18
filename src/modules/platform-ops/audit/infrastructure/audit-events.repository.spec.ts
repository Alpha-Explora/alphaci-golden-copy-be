import type { DatabaseService } from '#kernel/db/database.service';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';
import type {
  TenantContext,
  TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { AuditEventsRepository } from './audit-events.repository';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const makeDatabaseService = (query: jest.Mock) =>
  ({ query }) as unknown as DatabaseService;

const makeTenantContext = (tenantId = TENANT_A): TenantContextPort => {
  const context: TenantContext = {
    tenantId,
    userId: USER_ID,
    membershipRole: 'member',
    deploymentMode: 'hosted',
  };
  return {
    current: () => context,
    require: () => context,
    set: jest.fn(),
    clear: jest.fn(),
  };
};

describe('AuditEventsRepository', () => {
  let query: jest.Mock;
  let repository: AuditEventsRepository;

  beforeEach(() => {
    query = jest.fn();
    repository = new AuditEventsRepository(
      makeDatabaseService(query),
      makeTenantContext(),
    );
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

    const globalRepository = new AuditEventsRepository(
      makeDatabaseService(query),
    );
    await expect(
      globalRepository.createDeploymentGlobal({
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
      repository.createDeploymentGlobal({
        eventCode: 'workflow_pr_created',
        message: 'Workflow update PR created',
      }),
    ).rejects.toThrow('Audit event insert did not return a row');
  });

  it('lists project audit events for the owning user', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'event-1',
          workspace_id: 'workspace-1',
          project_id: 'project-1',
          actor_user_id: null,
          event_code: 'drift_detected',
          message: 'Drift detected',
          metadata_json: { severity: 'warning' },
          created_at: '2026-06-14T00:00:00.000Z',
        },
      ],
    });

    await expect(
      repository.listByProjectForUser('project-1', 'user-1', 10),
    ).resolves.toEqual([
      {
        id: 'event-1',
        workspaceId: 'workspace-1',
        projectId: 'project-1',
        actorUserId: null,
        eventCode: 'drift_detected',
        message: 'Drift detected',
        metadata: { severity: 'warning' },
        createdAt: '2026-06-14T00:00:00.000Z',
      },
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('JOIN projects.provisioned_projects'),
      ['project-1', 'user-1', TENANT_A, 10],
    );
    expect(String(query.mock.calls[0]?.[0] ?? '')).toContain(
      'project.tenant_id = $3::uuid',
    );
  });

  it('does not return events for a project outside the selected tenant', async () => {
    repository = new AuditEventsRepository(
      makeDatabaseService(query),
      makeTenantContext(TENANT_B),
    );
    query.mockResolvedValueOnce({ rows: [] });

    await expect(
      repository.listByProjectForUser('project-1', 'user-1'),
    ).resolves.toEqual([]);
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'project-1',
      'user-1',
      TENANT_B,
      50,
    ]);
  });

  it('fails closed when a user-facing project read has no tenant context', async () => {
    const unscopedRepository = new AuditEventsRepository(
      makeDatabaseService(query),
    );

    await expect(
      unscopedRepository.listByProjectForUser('project-1', 'user-1'),
    ).rejects.toBeInstanceOf(TenantContextRequiredError);
    expect(query).not.toHaveBeenCalled();
  });
});
