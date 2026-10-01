import { ConflictException } from '@nestjs/common';

import type { DatabaseService } from '#kernel/db/database.service';
import { HierarchyProjectLinkRepository } from './hierarchy-project-link.repository';

const INPUT = {
  projectId: 'p1',
  workspaceId: 'w1',
  name: 'payments-api',
  chainName: 'Payments',
  repoFullName: 'org/payments-api',
  visibility: 'private' as const,
  createdBy: 'u1',
  projectStatus: 'provisioned',
};

function build(clashRows: unknown[]) {
  const statements: string[] = [];
  const client = {
    query: jest.fn((sql: string) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (sql.includes('FROM hierarchy.delivery_projects')) {
        return Promise.resolve({ rows: clashRows });
      }
      if (sql.includes('INSERT INTO hierarchy.systems')) {
        return Promise.resolve({ rows: [{ id: 'sys-1' }] });
      }
      if (sql.includes('INSERT INTO hierarchy.delivery_projects')) {
        return Promise.resolve({ rows: [{ id: 'dp-new' }] });
      }
      if (sql.includes('INSERT INTO hierarchy.repositories')) {
        return Promise.resolve({ rows: [{ id: 'repo-1' }] });
      }
      return Promise.resolve({ rows: [] });
    }),
  };
  const databaseService = {
    withClient: jest.fn((fn: (c: typeof client) => Promise<unknown>) =>
      fn(client),
    ),
    query: jest.fn(),
  } as unknown as DatabaseService;
  return {
    repository: new HierarchyProjectLinkRepository(databaseService),
    client,
    statements,
  };
}

describe('HierarchyProjectLinkRepository.link — unique Project name', () => {
  it('takes the (team, name) advisory lock, re-checks, then creates the chain', async () => {
    const { repository, client, statements } = build([]);

    await expect(
      repository.link({ ...INPUT, enforceUniqueChainName: true }),
    ).resolves.toEqual({ repositoryId: 'repo-1', deliveryProjectId: 'dp-new' });

    const sqls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqls.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
    // Lock + check come before the first insert.
    const lockIdx = sqls.findIndex((s) => s.includes('pg_advisory_xact_lock'));
    const insertIdx = sqls.findIndex((s) =>
      s.includes('INSERT INTO hierarchy.systems'),
    );
    expect(lockIdx).toBeLessThan(insertIdx);
  });

  it('rolls back and throws 409 PROJECT_NAME_TAKEN when the name appeared since the pre-check', async () => {
    const { repository, client } = build([{ '?column?': 1 }]);

    const error = await repository
      .link({ ...INPUT, enforceUniqueChainName: true })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      code: 'PROJECT_NAME_TAKEN',
      message: 'A Project named "Payments" already exists in this team.',
    });
    const sqls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls.some((s) => s.includes('INSERT INTO hierarchy.systems'))).toBe(
      false,
    );
  });

  it('does not lock or check when the name is not caller-chosen (legacy naming)', async () => {
    const { repository, client } = build([{ '?column?': 1 }]);

    await expect(repository.link(INPUT)).resolves.toEqual({
      repositoryId: 'repo-1',
      deliveryProjectId: 'dp-new',
    });
    const sqls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqls.some((s) => s.includes('pg_advisory'))).toBe(false);
  });
});

describe('HierarchyProjectLinkRepository Project lookups', () => {
  const rows = [
    {
      delivery_project_id: 'dp-1',
      group_id: 'g-1',
      delivery_project_name: 'Checkout',
      provisioned_project_id: 'p-api',
      repository_name: 'api',
      repo_full_name: 'acme/api',
    },
    {
      delivery_project_id: 'dp-1',
      group_id: 'g-1',
      delivery_project_name: 'Checkout',
      provisioned_project_id: null,
      repository_name: 'ghost',
      repo_full_name: null,
    },
  ];

  function repo(result: unknown[]) {
    const query = jest.fn().mockResolvedValue({ rows: result });
    return {
      query,
      repository: new HierarchyProjectLinkRepository({
        query,
      } as unknown as DatabaseService),
    };
  }

  it('findDeliveryProject reads a Project by its own id, with its non-archived repositories', async () => {
    const { query, repository } = repo(rows);

    const folder = await repository.findDeliveryProject('dp-1');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE dp.id = $1'),
      ['dp-1'],
    );
    expect(folder).toEqual({
      deliveryProjectId: 'dp-1',
      groupId: 'g-1',
      name: 'Checkout',
      repositories: [
        { projectId: 'p-api', name: 'api', repoFullName: 'acme/api' },
        { projectId: null, name: 'ghost', repoFullName: null },
      ],
    });
  });

  it('findDeliveryProject is null for an unknown Project, and findProjectFolder still resolves by repository', async () => {
    expect(await repo([]).repository.findDeliveryProject('nope')).toBeNull();

    const { query, repository } = repo(rows);
    await repository.findProjectFolder('p-api');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('self.provisioned_project_id = $1'),
      ['p-api'],
    );
  });

  it('listActiveDeliveryProjects lists a group active Projects oldest first', async () => {
    const { query, repository } = repo([{ id: 'dp-1', name: 'Checkout' }]);

    expect(await repository.listActiveDeliveryProjects('g-1')).toEqual([
      { id: 'dp-1', name: 'Checkout' },
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'active'"),
      ['g-1'],
    );
  });
});
