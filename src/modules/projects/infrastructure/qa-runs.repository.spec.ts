import type { DatabaseService } from '#kernel/db/database.service';
import {
  QaRunItemsChangedError,
  QaRunNotOpenError,
  QaRunsRepository,
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

  it('returns null without writing when the run is no longer open', async () => {
    query.mockResolvedValueOnce({ rows: [{ status: 'signed_off' }] });

    await expect(repository.createSignoff(signoffInput())).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
