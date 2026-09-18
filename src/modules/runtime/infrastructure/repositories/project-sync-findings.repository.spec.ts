import type { DatabaseService } from '#kernel/db/database.service';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';
import type {
  TenantContext,
  TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { ProjectSyncFindingsRepository } from './project-sync-findings.repository';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const makeDatabaseService = (query: jest.Mock) =>
  ({
    query,
  }) as unknown as DatabaseService;

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

describe('ProjectSyncFindingsRepository', () => {
  let query: jest.Mock;
  let repository: ProjectSyncFindingsRepository;

  beforeEach(() => {
    query = jest.fn();
    repository = new ProjectSyncFindingsRepository(
      makeDatabaseService(query),
      makeTenantContext(),
    );
  });

  it('maps active project findings from storage rows', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'finding-1',
          project_id: 'project-1',
          target_id: null,
          source: 'local_snapshot',
          severity: 'warning',
          code: 'workflow_files_missing',
          message: 'No workflow file metadata is tracked.',
          details_json: { path: '.github/workflows/ci.yml' },
          status: 'active',
          detected_at: '2026-06-13T00:00:00.000Z',
          resolved_at: null,
        },
      ],
    });

    await expect(repository.findActiveByProject('project-1')).resolves.toEqual([
      expect.objectContaining({
        id: 'finding-1',
        projectId: 'project-1',
        code: 'workflow_files_missing',
        details: { path: '.github/workflows/ci.yml' },
      }),
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'active'"),
      ['project-1', TENANT_A],
    );
    expect(String(query.mock.calls[0]?.[0] ?? '')).toContain(
      'project.tenant_id = $2::uuid',
    );
  });

  it('resolves missing active findings and inserts new stable-code findings', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'old-finding',
            project_id: 'project-1',
            target_id: null,
            source: 'local_snapshot',
            severity: 'warning',
            code: 'workflow_files_missing',
            message: 'old',
            details_json: {},
            status: 'active',
            detected_at: '2026-06-13T00:00:00.000Z',
            resolved_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'new-finding',
            project_id: 'project-1',
            target_id: 'target-1',
            source: 'local_snapshot',
            severity: 'error',
            code: 'deployment_target_metadata_missing',
            message: 'Target metadata is missing.',
            details_json: '{}',
            status: 'active',
            detected_at: '2026-06-13T00:00:01.000Z',
            resolved_at: null,
          },
        ],
      });

    await expect(
      repository.replaceActiveFindings('project-1', [
        {
          projectId: 'project-1',
          targetId: 'target-1',
          source: 'local_snapshot',
          severity: 'error',
          code: 'deployment_target_metadata_missing',
          message: 'Target metadata is missing.',
        },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'new-finding',
        targetId: 'target-1',
        code: 'deployment_target_metadata_missing',
      }),
    ]);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'resolved'"),
      ['old-finding', 'project-1', TENANT_A],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO projects.project_sync_findings'),
      [
        'project-1',
        'target-1',
        'local_snapshot',
        'error',
        'deployment_target_metadata_missing',
        'Target metadata is missing.',
        JSON.stringify({}),
        TENANT_A,
      ],
    );
    expect(String(query.mock.calls[2]?.[0] ?? '')).toContain(
      'project.tenant_id = $8::uuid',
    );
  });

  it('finds a finding by project and id', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'finding-1',
          project_id: 'project-1',
          target_id: null,
          source: 'local_snapshot',
          severity: 'error',
          code: 'ci_token_missing',
          message: 'No token',
          details_json: {},
          status: 'active',
          detected_at: '2026-06-13T00:00:00.000Z',
          resolved_at: null,
        },
      ],
    });

    await expect(
      repository.findByIdForProject('project-1', 'finding-1'),
    ).resolves.toMatchObject({
      id: 'finding-1',
      code: 'ci_token_missing',
    });
    expect(query.mock.calls[0]?.[1]).toEqual([
      'project-1',
      'finding-1',
      TENANT_A,
    ]);
  });

  it('marks a finding resolved or ignored', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await repository.markStatus('finding-1', 'ignored');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SET status = $2'),
      ['finding-1', 'ignored', TENANT_A],
    );
    expect(String(query.mock.calls[0]?.[0] ?? '')).toContain(
      'project.tenant_id = $3::uuid',
    );
  });

  it('keeps a tenant A context from reading or mutating tenant B findings', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(
      repository.findActiveByProject('tenant-b-project'),
    ).resolves.toEqual([]);
    await expect(
      repository.markStatus('tenant-b-finding', 'ignored'),
    ).resolves.toBeUndefined();

    expect(query.mock.calls[0]?.[1]).toEqual(['tenant-b-project', TENANT_A]);
    expect(query.mock.calls[1]?.[1]).toEqual([
      'tenant-b-finding',
      'ignored',
      TENANT_A,
    ]);
  });

  it('fails closed before querying when the validated tenant context is absent', async () => {
    const noContext: TenantContextPort = {
      current: () => null,
      require: () => {
        throw new TenantContextRequiredError();
      },
      set: jest.fn(),
      clear: jest.fn(),
    };
    const noContextRepository = new ProjectSyncFindingsRepository(
      makeDatabaseService(query),
      noContext,
    );

    await expect(
      noContextRepository.findActiveByProject('project-1'),
    ).rejects.toThrow(TenantContextRequiredError);
    expect(query).not.toHaveBeenCalled();
  });
});
