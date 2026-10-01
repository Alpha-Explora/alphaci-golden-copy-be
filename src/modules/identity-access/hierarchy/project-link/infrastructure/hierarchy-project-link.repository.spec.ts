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
