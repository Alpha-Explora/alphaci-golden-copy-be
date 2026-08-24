import { CiTokensRepository } from './ci-tokens.repository';
import type { DatabaseService } from '../../kernel/db/database.service';

const makeDatabaseService = (query: jest.Mock) =>
  ({
    query,
  }) as unknown as DatabaseService;

describe('CiTokensRepository', () => {
  let databaseService: DatabaseService;
  let query: jest.Mock;
  let repository: CiTokensRepository;

  beforeEach(() => {
    query = jest.fn();
    databaseService = makeDatabaseService(query);
    repository = new CiTokensRepository(databaseService);
  });

  it('stores only the token hash for a project token', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await repository.upsertProjectToken({
      projectId: 'project-1',
      tokenHash: 'sha256-token',
      tokenPrefix: 'aci_123456',
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO ci.project_ci_tokens'),
      ['project-1', 'sha256-token', 'aci_123456'],
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
    };
    query.mockResolvedValueOnce({ rows: [row] });

    const result = await repository.findValidationContext(
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
      ['project-1'],
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
      ['project-1'],
    );
  });
});
