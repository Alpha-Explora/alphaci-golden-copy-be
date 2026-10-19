import type { DatabaseService } from '#kernel/db/database.service';
import {
  QaRunItemsChangedError,
  QaRunNotOpenError,
  QaRunsRepository,
  QaTestCasesOpenError,
  type CreateSignoffInput,
  type UpdateQaRunItemPatch,
} from './qa-runs.repository';

const makeDatabaseService = (query: jest.Mock) =>
  ({
    query,
    withTransaction: jest.fn(
      async (fn: (client: { query: jest.Mock }) => unknown) => fn({ query }),
    ),
  }) as unknown as DatabaseService;

const actor = { id: 'user-1', login: 'quinn' };

/** Every field present, as UpdateQaRunItemPatch requires under exactOptionalPropertyTypes. */
const patch = (
  fields: Partial<UpdateQaRunItemPatch>,
): UpdateQaRunItemPatch => ({
  status: undefined,
  notes: undefined,
  defectSeverity: undefined,
  reproductionSteps: undefined,
  ...fields,
});

const signoffInput = (
  overrides: Partial<CreateSignoffInput> = {},
): CreateSignoffInput => ({
  id: 'signoff-1',
  runId: 'run-1',
  verdict: 'APPROVED',
  summary: null,
  conditions: null,
  signedBy: 'user-1',
  signedByLogin: 'quinn',
  signedAt: '2026-09-25T00:00:00.000Z',
  reportJson: {},
  expectedItems: { count: 2, rowVersionSum: 5 },
  ...overrides,
});

/*
 * These pin the concurrency contract. Item writes and signoff each lock the
 * run row inside their own transaction (FOR SHARE vs FOR UPDATE), so a signoff
 * can never interleave with an item write: the service-level "is it open?"
 * check alone left a window where either could slip past the other.
 */
describe('QaRunsRepository concurrency guards', () => {
  let query: jest.Mock;
  let repository: QaRunsRepository;

  beforeEach(() => {
    query = jest.fn();
    repository = new QaRunsRepository(makeDatabaseService(query));
  });

  it('locks the run FOR SHARE before updating an item', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'item-1', status: 'passed' }] })
      .mockResolvedValueOnce({ rows: [] });

    await repository.updateItem(
      'run-1',
      'item-1',
      1,
      patch({ status: 'passed' }),
      actor,
      'pending',
    );

    const [lockSql, lockParams] = query.mock.calls[0] as [string, unknown[]];
    expect(lockSql).toMatch(/FROM projects\.qa_verification_runs/);
    expect(lockSql).toMatch(/FOR SHARE/);
    expect(lockParams).toEqual(['run-1']);
    expect(query.mock.calls[1]?.[0]).toMatch(/UPDATE projects\.qa_run_items/);
  });

  it('clears the previous fix request when an item is returned to dev again', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'item-1', status: 'returned_to_dev' }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await repository.updateItem(
      'run-1',
      'item-1',
      4,
      patch({ status: 'returned_to_dev', defectSeverity: 'major' }),
      actor,
      'pending',
    );

    const updateSql = query.mock.calls[1]?.[0] as string;
    for (const column of [
      'fix_requested_at',
      'fix_requested_by',
      'fix_requested_by_login',
      'fix_note',
    ]) {
      expect(updateSql).toContain(
        `${column} = CASE WHEN $4::text = 'returned_to_dev' THEN NULL`,
      );
    }
  });

  it('refuses an item update once the run is signed off, without writing', async () => {
    query.mockResolvedValueOnce({ rows: [{ status: 'signed_off' }] });

    await expect(
      repository.updateItem(
        'run-1',
        'item-1',
        1,
        patch({ status: 'failed' }),
        actor,
        'pending',
      ),
    ).rejects.toBeInstanceOf(QaRunNotOpenError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuses a pass while a test case is open, under the run item lock, without writing', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'item-1' }] })
      .mockResolvedValueOnce({ rows: [{ n: 2 }] });

    await expect(
      repository.updateItem(
        'run-1',
        'item-1',
        1,
        patch({ status: 'passed' }),
        actor,
        'pending',
        {
          requireProgressDoneForPass: false,
          resetProgressOnReturn: false,
          requireTestCasesResolvedForPass: true,
        },
      ),
    ).rejects.toEqual(expect.any(QaTestCasesOpenError));
    expect(query.mock.calls[1]?.[0]).toMatch(/qa_run_items[\s\S]*FOR UPDATE/);
    expect(query.mock.calls[2]?.[0]).toContain(
      "status IN ('pending', 'failed', 'blocked')",
    );
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('passes once every test case is resolved', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'item-1' }] })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'item-1', status: 'passed' }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      repository.updateItem(
        'run-1',
        'item-1',
        1,
        patch({ status: 'passed' }),
        actor,
        'pending',
        {
          requireProgressDoneForPass: false,
          resetProgressOnReturn: false,
          requireTestCasesResolvedForPass: true,
        },
      ),
    ).resolves.toMatchObject({ status: 'passed' });
  });

  it('refuses a re-test request once the run is signed off, without writing', async () => {
    query.mockResolvedValueOnce({ rows: [{ status: 'signed_off' }] });

    await expect(
      repository.requestRetest('run-1', 'item-1', actor, null),
    ).rejects.toBeInstanceOf(QaRunNotOpenError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('locks the run FOR UPDATE and signs off when the items are unchanged', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({ rows: [{ count: '2', row_version_sum: '5' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'run-1', status: 'signed_off' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'signoff-1' }] });

    const result = await repository.createSignoff(signoffInput());

    expect(query.mock.calls[0]?.[0]).toMatch(/FOR UPDATE/);
    expect(result?.signoff).toEqual({ id: 'signoff-1' });
  });

  it('aborts the signoff when an item changed after the report was built', async () => {
    // One item was edited in between: its row_version bumped, so the sum moved.
    query
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({ rows: [{ count: '2', row_version_sum: '6' }] });

    await expect(
      repository.createSignoff(signoffInput()),
    ).rejects.toBeInstanceOf(QaRunItemsChangedError);
    // Neither the status flip nor the signoff insert ran.
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('aborts a Project signoff when an attachment was added or removed after the report was built', async () => {
    // Attachments do not bump an item's row_version, so the report's own
    // attachment ids are checked under the run lock.
    query
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({ rows: [{ count: '2', row_version_sum: '5' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 'att-1' }, { id: 'att-2' }, { id: 'att-3' }],
      });

    await expect(
      repository.createSignoff(
        signoffInput({ expectedAttachmentIds: ['att-1', 'att-2'] }),
      ),
    ).rejects.toBeInstanceOf(QaRunItemsChangedError);
    expect(String(query.mock.calls[2]?.[0])).toMatch(/qa_run_item_attachments/);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('aborts a Project signoff when one screenshot was swapped for another (same count)', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({ rows: [{ count: '2', row_version_sum: '5' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'att-1' }, { id: 'att-9' }] });

    await expect(
      repository.createSignoff(
        signoffInput({ expectedAttachmentIds: ['att-1', 'att-2'] }),
      ),
    ).rejects.toBeInstanceOf(QaRunItemsChangedError);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('signs off when the attachments still match the report, in any order', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({ rows: [{ count: '2', row_version_sum: '5' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'att-2' }, { id: 'att-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'run-1', status: 'signed_off' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'signoff-1' }] });

    const result = await repository.createSignoff(
      signoffInput({ expectedAttachmentIds: ['att-1', 'att-2'] }),
    );

    expect(result?.signoff).toEqual({ id: 'signoff-1' });
  });

  it('returns null without writing when the run is no longer open', async () => {
    query.mockResolvedValueOnce({ rows: [{ status: 'signed_off' }] });

    await expect(repository.createSignoff(signoffInput())).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reopen supersedes the active signoff with the actor id and login', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'run-1', status: 'open' }] })
      .mockResolvedValueOnce({ rows: [] });

    await repository.reopenRun('run-1', actor);

    const [supersedeSql, supersedeParams] = query.mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(supersedeSql).toMatch(/superseded_by_login = \$3/);
    expect(supersedeParams).toEqual(['run-1', actor.id, actor.login]);
  });

  it('reopen returns null without superseding when the run is not signed off', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(repository.reopenRun('run-1', actor)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('QaRunsRepository.listSupersededSignoffs', () => {
  it('queries only superseded rows for the run, oldest first', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repository = new QaRunsRepository(makeDatabaseService(query));

    await repository.listSupersededSignoffs('run-1');

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE run_id = \$1 AND superseded_at IS NOT NULL/);
    expect(sql).toMatch(/ORDER BY signed_at ASC/);
    expect(params).toEqual(['run-1']);
  });
});
