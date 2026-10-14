import { RepositoriesRepository } from './repositories.repository';

function setup() {
  const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const repository = new RepositoriesRepository({ query } as never);
  return { repository, query };
}

describe('RepositoriesRepository origin (automatic GitHub grants only for created repositories)', () => {
  it('members/sync candidates are limited to repositories ALPHACI created, never attached ones', async () => {
    const { repository } = setup();
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await repository.listActiveForGrantWithClient(client, 'dp-1');
    const sql = client.query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("origin = 'created'");
    expect(sql).toContain("status = 'active'");
  });

  it('a repository created through the hierarchy is recorded as created', async () => {
    const { repository, query } = setup();
    query.mockResolvedValue({
      rows: [
        {
          id: 'r1',
          delivery_project_id: 'dp-1',
          group_id: 'g1',
          name: 'n',
          repo_full_name: 'o/n',
          github_repo_id: null,
          visibility: 'private',
          created_by: 'u1',
          status: 'active',
          archived_at: null,
          provisioned_project_id: 'p1',
          created_at: 'x',
          updated_at: 'x',
        },
      ],
    });
    await repository.create({
      deliveryProjectId: 'dp-1',
      groupId: 'g1',
      name: 'n',
      repoFullName: 'o/n',
      createdBy: 'u1',
      provisionedProjectId: 'p1',
    });
    expect(query.mock.calls[0]?.[0] as string).toContain("'created'");
  });

  it('isCreatedByAlphaci is true only for origin created', async () => {
    const { repository, query } = setup();
    query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
    await expect(repository.isCreatedByAlphaci('r1')).resolves.toBe(true);
    expect(query.mock.calls[0]?.[0] as string).toContain("origin = 'created'");
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(repository.isCreatedByAlphaci('r2')).resolves.toBe(false);
  });
});
