import { Test } from '@nestjs/testing';

import { DatabaseService } from '../../../kernel/db/database.service';
import { EnvVarsRepository } from '../infrastructure/env-vars.repository';

describe('EnvVarsRepository', () => {
  it('persists env metadata without env values', async () => {
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as DatabaseService;
    const module = await Test.createTestingModule({
      providers: [
        EnvVarsRepository,
        { provide: DatabaseService, useValue: database },
      ],
    }).compile();

    const repository = module.get(EnvVarsRepository);
    await repository.upsertEnvMetadataBatch({
      projectId: 'project-1',
      deploymentTargetId: 'target-1',
      lane: 'preview',
      gitBranch: 'feat/checkout',
      provider: 'render',
      provisionedBy: 'user-1',
      entries: [
        {
          key: 'DATABASE_URL',
          status: 'provisioned',
          errorSummary: null,
        },
      ],
    });

    const call = (
      database.query as jest.MockedFunction<DatabaseService['query']>
    ).mock.calls[0];
    const queryText = String(call?.[0] ?? '');
    const queryValues = call?.[1] ?? [];
    expect(queryText).toContain(
      'INSERT INTO env_provisioning.project_env_var_metadata',
    );
    expect(queryValues).toContain('DATABASE_URL');
    expect(queryValues).not.toContain('postgres://secret');
  });

  it('filters removed metadata from active env metadata lists', async () => {
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as DatabaseService;
    const module = await Test.createTestingModule({
      providers: [
        EnvVarsRepository,
        { provide: DatabaseService, useValue: database },
      ],
    }).compile();

    const repository = module.get(EnvVarsRepository);
    await repository.listEnvMetadata('project-1');

    const queryText = String(
      (database.query as jest.MockedFunction<DatabaseService['query']>).mock
        .calls[0]?.[0] ?? '',
    );
    expect(queryText).toContain('removed_at IS NULL');
  });

  it('lists env metadata only for projects owned by the user', async () => {
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as unknown as DatabaseService;
    const module = await Test.createTestingModule({
      providers: [
        EnvVarsRepository,
        { provide: DatabaseService, useValue: database },
      ],
    }).compile();

    const repository = module.get(EnvVarsRepository);
    await repository.listEnvMetadataForUser('project-1', 'user-1');

    const query = database.query as jest.MockedFunction<
      DatabaseService['query']
    >;
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('JOIN projects.provisioned_projects AS project'),
      ['project-1', 'user-1'],
    );
    const queryText = String(query.mock.calls[0]?.[0] ?? '');
    expect(queryText).toContain('metadata.project_id = $1');
    expect(queryText).toContain('project.user_id = $2');
    expect(queryText).toContain('orgs.workspace_members');
    expect(queryText).toContain(
      "member.role IN ('admin', 'delegated_lead', 'member', 'viewer')",
    );
    expect(queryText).toContain('metadata.removed_at IS NULL');
  });

  it('counts existing active env keys for a target and environment', async () => {
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [{ existing_count: '2' }] }),
    } as unknown as DatabaseService;
    const module = await Test.createTestingModule({
      providers: [
        EnvVarsRepository,
        { provide: DatabaseService, useValue: database },
      ],
    }).compile();

    const repository = module.get(EnvVarsRepository);
    await expect(
      repository.countExistingActiveKeys({
        deploymentTargetId: 'target-1',
        lane: 'preview',
        gitBranch: 'feat/checkout',
        keys: ['API_URL', 'DATABASE_URL', 'NEW_KEY'],
      }),
    ).resolves.toBe(2);

    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining('key = ANY($4::text[])'),
      [
        'target-1',
        'preview',
        'feat/checkout',
        ['API_URL', 'DATABASE_URL', 'NEW_KEY'],
      ],
    );
  });

  it('marks env metadata removed without deleting the row', async () => {
    const database = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            id: 'meta-1',
            project_id: 'project-1',
            deployment_target_id: 'target-1',
            environment: 'test',
            key: 'DATABASE_URL',
            provider: 'render',
            value_stored: false,
            last_provisioned_at: '2026-06-12T00:00:00.000Z',
            last_provisioned_by: 'user-1',
            status: 'provisioned',
            error_summary: null,
            removed_at: '2026-06-12T01:00:00.000Z',
          },
        ],
      }),
    } as unknown as DatabaseService;
    const module = await Test.createTestingModule({
      providers: [
        EnvVarsRepository,
        { provide: DatabaseService, useValue: database },
      ],
    }).compile();

    const repository = module.get(EnvVarsRepository);
    await expect(
      repository.markEnvMetadataRemoved('meta-1', 'user-1', null),
    ).resolves.toMatchObject({
      id: 'meta-1',
      key: 'DATABASE_URL',
      removedAt: '2026-06-12T01:00:00.000Z',
    });

    const queryText = String(
      (database.query as jest.MockedFunction<DatabaseService['query']>).mock
        .calls[0]?.[0] ?? '',
    );
    expect(queryText).toContain('SET removed_at = NOW()');
    expect(queryText).toContain('orgs.workspace_members');
    expect(queryText).toContain(
      "member.role IN ('admin', 'delegated_lead', 'member')",
    );
    expect(queryText).not.toContain('DELETE FROM');
  });
});
