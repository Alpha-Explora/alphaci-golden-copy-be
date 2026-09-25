import type { DatabaseService } from '#kernel/db/database.service';
import { QaChecklistsRepository } from './qa-checklists.repository';

const makeDatabaseService = (query: jest.Mock, withTransaction?: jest.Mock) =>
  ({
    query,
    withTransaction:
      withTransaction ??
      jest.fn(async (fn: (client: { query: jest.Mock }) => unknown) =>
        fn({ query }),
      ),
  }) as unknown as DatabaseService;

const checklistRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'checklist-1',
  workspace_id: 'workspace-1',
  name: 'Release checklist',
  description: null,
  version: 1,
  archived_at: null,
  created_by: 'user-1',
  updated_by: null,
  created_at: '2026-09-25T00:00:00.000Z',
  updated_at: '2026-09-25T00:00:00.000Z',
  ...overrides,
});

describe('QaChecklistsRepository', () => {
  let query: jest.Mock;
  let repository: QaChecklistsRepository;

  beforeEach(() => {
    query = jest.fn();
    repository = new QaChecklistsRepository(makeDatabaseService(query));
  });

  it('deleteByWorkspace deletes every checklist of the workspace and returns the count', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 3 });

    await expect(repository.deleteByWorkspace('workspace-1')).resolves.toBe(3);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      'DELETE FROM projects.qa_checklists WHERE workspace_id = $1',
    );
    expect(params).toEqual(['workspace-1']);
  });

  it('createWithItems inserts the checklist then its items inside one transaction', async () => {
    query
      .mockResolvedValueOnce({ rows: [checklistRow()] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'item-1',
            checklist_id: 'checklist-1',
            position: 0,
            title: 'Smoke test the login flow',
            description: null,
            target_persona: 'qa',
            verification_type: 'manual',
            test_identifier: null,
          },
        ],
      });

    const result = await repository.createWithItems({
      workspaceId: 'workspace-1',
      name: 'Release checklist',
      description: null,
      createdBy: 'user-1',
      items: [
        {
          title: 'Smoke test the login flow',
          targetPersona: 'qa',
          verificationType: 'manual',
        },
      ],
    });

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO projects.qa_checklists'),
      ['workspace-1', 'Release checklist', null, 'user-1'],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO projects.qa_checklist_items'),
      [
        'checklist-1',
        0,
        'Smoke test the login flow',
        null,
        'qa',
        'manual',
        null,
      ],
    );
    expect(result.checklist.id).toBe('checklist-1');
    expect(result.items).toHaveLength(1);
  });

  it('hasActiveNameConflict is case-insensitive and excludes the given id', async () => {
    query.mockResolvedValueOnce({ rows: [{ exists: true }] });

    const result = await repository.hasActiveNameConflict(
      'workspace-1',
      'RELEASE CHECKLIST',
      'checklist-1',
    );

    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'workspace-1',
      'RELEASE CHECKLIST',
      'checklist-1',
    ]);
    expect(result).toBe(true);
  });

  it('updateMeta distinguishes "not provided" from "explicit null" for description', async () => {
    query.mockResolvedValueOnce({ rows: [checklistRow({ version: 2 })] });

    await repository.updateMeta(
      'checklist-1',
      1,
      { description: null },
      'user-2',
    );

    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'checklist-1',
      1,
      null, // name left unchanged
      true, // description WAS provided (explicit null)
      null, // ...and it clears to null
      'user-2',
    ]);
  });

  it('updateMeta returns null on a version/archived race (0 rows back)', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await repository.updateMeta(
      'checklist-1',
      1,
      { name: 'New name' },
      'user-2',
    );

    expect(result).toBeNull();
  });

  it('replaceItems returns null without touching items when the version bump affects no row', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // the UPDATE ... RETURNING *

    const result = await repository.replaceItems(
      'checklist-1',
      1,
      [
        {
          title: 'Item',
          targetPersona: 'all',
          verificationType: 'manual',
        },
      ],
      'user-2',
    );

    expect(result).toBeNull();
    expect(query).toHaveBeenCalledTimes(1); // no DELETE, no INSERT followed
  });

  it('archive is idempotent (COALESCE keeps the original archived_at)', async () => {
    query.mockResolvedValueOnce({
      rows: [checklistRow({ archived_at: '2026-09-01T00:00:00.000Z' })],
    });

    const result = await repository.archive('checklist-1', 'user-2');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('COALESCE(archived_at, NOW())'),
      ['checklist-1', 'user-2'],
    );
    expect(result?.archived_at).toBe('2026-09-01T00:00:00.000Z');
  });

  it('validWorkspaceProjectIds returns only ids that belong to the workspace', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'project-1' }] });

    const result = await repository.validWorkspaceProjectIds('workspace-1', [
      'project-1',
      'project-2',
    ]);

    expect(result).toEqual(['project-1']);
  });

  it('replaceSharedProjects deletes the old set then inserts only workspace-matching projects', async () => {
    query
      .mockResolvedValueOnce({ rows: [] }) // DELETE
      .mockResolvedValueOnce({ rows: [{ project_id: 'project-1' }] }); // INSERT ... SELECT

    const result = await repository.replaceSharedProjects(
      'checklist-1',
      ['project-1'],
      'user-2',
    );

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('DELETE FROM projects.qa_checklist_projects'),
      ['checklist-1'],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('pp.workspace_id = c.workspace_id'),
      ['checklist-1', ['project-1'], 'user-2'],
    );
    expect(result).toEqual(['project-1']);
  });

  it('replaceSharedProjects short-circuits the INSERT when the new set is empty', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // DELETE only

    const result = await repository.replaceSharedProjects(
      'checklist-1',
      [],
      'user-2',
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });
});
