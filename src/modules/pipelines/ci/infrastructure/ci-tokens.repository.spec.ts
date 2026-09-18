import { CiTokensRepository } from './ci-tokens.repository';
import type { DatabaseService } from '#kernel/db/database.service';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';
import type {
  TenantContext,
  TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
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

describe('CiTokensRepository', () => {
  let databaseService: DatabaseService;
  let query: jest.Mock;
  let repository: CiTokensRepository;

  beforeEach(() => {
    query = jest.fn();
    databaseService = makeDatabaseService(query);
    repository = new CiTokensRepository(databaseService, makeTenantContext());
  });

  it('stores only the token hash for a project token', async () => {
    query.mockResolvedValueOnce({ rows: [{ project_id: 'project-1' }] });

    await repository.upsertProjectToken({
      projectId: 'project-1',
      tokenHash: 'sha256-token',
      tokenPrefix: 'aci_123456',
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO ci.project_ci_tokens'),
      ['project-1', 'sha256-token', 'aci_123456', TENANT_A],
    );
    expect(String(query.mock.calls[0]?.[0] ?? '')).toContain(
      'project.tenant_id = $4::uuid',
    );
  });

  it('loads an active token with project and subscription context', async () => {
    const row = {
      project_id: 'project-1',
      user_id: 'user-1',
      repo_full_name: 'owner/repo',
      project_status: 'provisioned',
      token_status: 'active',
      subscription_status: 'active',
      is_internal: false,
    };
    query.mockResolvedValueOnce({ rows: [row] });

    const globalRepository = new CiTokensRepository(databaseService);
    const result = await globalRepository.findDeploymentGlobalValidationContext(
      'sha256-token',
      'owner/repo',
    );

    expect(result).toEqual(row);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('JOIN projects.provisioned_projects'),
      ['sha256-token', 'owner/repo'],
    );
  });

  it('revokes active tokens for a project', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await repository.revokeProjectTokens('project-1');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'revoked'"),
      ['project-1', TENANT_A],
    );
    expect(String(query.mock.calls[0]?.[0] ?? '')).toContain(
      'project.tenant_id = $2::uuid',
    );
  });

  it('loads token status metadata for a project overview', async () => {
    const row = {
      status: 'revoked',
      token_prefix: 'aci_123456',
      created_at: '2026-06-12T00:00:00.000Z',
      updated_at: '2026-06-12T01:00:00.000Z',
      revoked_at: '2026-06-12T01:00:00.000Z',
    };
    query.mockResolvedValueOnce({ rows: [row] });

    const result = await repository.findProjectTokenStatus('project-1');

    expect(result).toEqual({
      status: 'revoked',
      tokenPrefix: 'aci_123456',
      createdAt: '2026-06-12T00:00:00.000Z',
      updatedAt: '2026-06-12T01:00:00.000Z',
      revokedAt: '2026-06-12T01:00:00.000Z',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM ci.project_ci_tokens'),
      ['project-1', TENANT_A],
    );
    expect(String(query.mock.calls[0]?.[0] ?? '')).toContain(
      'project.tenant_id = $2::uuid',
    );
  });

  it('returns no status when the selected tenant does not own the project', async () => {
    repository = new CiTokensRepository(
      databaseService,
      makeTenantContext(TENANT_B),
    );
    query.mockResolvedValueOnce({ rows: [] });

    await expect(
      repository.findProjectTokenStatus('project-1'),
    ).resolves.toBeNull();
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'project-1',
      TENANT_B,
    ]);
  });

  it('fails closed when a request-facing token read has no tenant context', async () => {
    const unscopedRepository = new CiTokensRepository(databaseService);

    await expect(
      unscopedRepository.findProjectTokenStatus('project-1'),
    ).rejects.toBeInstanceOf(TenantContextRequiredError);
    expect(query).not.toHaveBeenCalled();
  });
});
