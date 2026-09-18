import type { DatabaseService } from '#kernel/db/database.service';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';
import { AssignmentsRepository } from './assignments.repository';
import { DeliveryProjectsRepository } from './delivery-projects.repository';
import { GroupActivityRepository } from './group-activity.repository';
import { HierarchyProjectLinkRepository } from '../project-link/infrastructure/hierarchy-project-link.repository';
import { RepoConfigurationChangesRepository } from './repo-configuration-changes.repository';
import { RepositoriesRepository } from './repositories.repository';
import { SystemsRepository } from './systems.repository';

const makeDatabaseService = () =>
  ({
    query: jest.fn().mockResolvedValue({ rows: [] }),
    withClient: jest.fn(),
    withTransaction: jest.fn(),
  }) as unknown as DatabaseService;

const makeOutboxRepository = () =>
  ({
    publishInTransaction: jest.fn(),
  }) as never;

describe('hierarchy repository tenant boundaries', () => {
  const requestRepositoryCases: Array<
    [string, (db: DatabaseService) => Promise<unknown>]
  > = [
    [
      'systems',
      (db: DatabaseService) => new SystemsRepository(db).findById('system-1'),
    ],
    [
      'delivery projects',
      (db: DatabaseService) =>
        new DeliveryProjectsRepository(db).findById('delivery-project-1'),
    ],
    [
      'repositories',
      (db: DatabaseService) =>
        new RepositoriesRepository(db).findById('repository-1'),
    ],
    [
      'assignments',
      (db: DatabaseService) =>
        new AssignmentsRepository(db, makeOutboxRepository()).findById(
          'assignment-1',
        ),
    ],
    [
      'group activity',
      (db: DatabaseService) =>
        new GroupActivityRepository(db).list('group-1', {}),
    ],
    [
      'project links',
      (db: DatabaseService) =>
        new HierarchyProjectLinkRepository(db).isTeamWorkspace('group-1'),
    ],
    [
      'configuration changes',
      (db: DatabaseService) =>
        new RepoConfigurationChangesRepository(db).listCurrentNames(
          'repository-1',
          'variable',
        ),
    ],
  ];

  it.each(requestRepositoryCases)(
    'fails closed without a validated context: %s',
    async (_name, call) => {
      const db = makeDatabaseService();

      await expect(call(db)).rejects.toBeInstanceOf(TenantContextRequiredError);
      expect(db.query).not.toHaveBeenCalled();
    },
  );

  it('keeps durable GitHub assignment lookup explicitly worker-global', async () => {
    const db = makeDatabaseService();
    const repository = new AssignmentsRepository(db, makeOutboxRepository());

    await expect(
      repository.findByIdForWorker('assignment-1'),
    ).resolves.toBeNull();

    const [sql, params] = (db.query as jest.Mock).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain('FROM hierarchy.repository_assignments');
    expect(sql).not.toContain('tenant_id');
    expect(params).toEqual(['assignment-1']);
  });

  it('keeps durable GitHub repository lookup explicitly worker-global', async () => {
    const db = makeDatabaseService();
    const repository = new RepositoriesRepository(db);

    await expect(
      repository.findByIdForWorker('repository-1'),
    ).resolves.toBeNull();

    const [sql, params] = (db.query as jest.Mock).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain('FROM hierarchy.repositories');
    expect(sql).not.toContain('tenant_id');
    expect(params).toEqual(['repository-1']);
  });
});
