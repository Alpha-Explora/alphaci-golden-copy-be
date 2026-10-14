import type { DatabaseService } from '#kernel/db/database.service';
import {
  QaAttachmentItemGoneError,
  QaAttachmentLimitReachedError,
  QaRunAttachmentsRepository,
  type InsertQaAttachmentInput,
} from './qa-run-attachments.repository';
import { QaRunNotOpenError } from './qa-runs.repository';

const makeDatabaseService = (query: jest.Mock) =>
  ({
    query,
    withTransaction: jest.fn(
      async (fn: (client: { query: jest.Mock }) => unknown) => fn({ query }),
    ),
  }) as unknown as DatabaseService;

const input = (
  overrides: Partial<InsertQaAttachmentInput> = {},
): InsertQaAttachmentInput => ({
  id: 'att-1',
  runId: 'run-1',
  runItemId: 'ri-1',
  kind: 'evidence',
  storagePath: 'run-1/ri-1/att-1.png',
  contentType: 'image/png',
  byteSize: 100,
  width: 10,
  height: 10,
  caption: null,
  source: 'upload',
  createdBy: 'qa-1',
  createdByLogin: 'qa',
  maxHumanPerItem: 5,
  ...overrides,
});

describe('QaRunAttachmentsRepository write guards', () => {
  let query: jest.Mock;
  let repository: QaRunAttachmentsRepository;

  beforeEach(() => {
    query = jest.fn();
    repository = new QaRunAttachmentsRepository(makeDatabaseService(query));
  });

  it('locks the run FOR SHARE, then the item FOR UPDATE, then counts human attachments, then inserts', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
      .mockResolvedValueOnce({ rows: [{ count: '4' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'att-1' }] });

    const row = await repository.insert(input());

    expect(row).toEqual({ id: 'att-1' });
    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql[0]).toMatch(/qa_verification_runs[\s\S]*FOR SHARE/);
    expect(sql[1]).toMatch(/qa_run_items[\s\S]*FOR UPDATE/);
    expect(sql[2]).toMatch(/kind <> 'automated'/);
    expect(sql[3]).toMatch(/INSERT INTO projects\.qa_run_item_attachments/);
  });

  it('throws QaRunNotOpenError without touching the item when the run is signed off', async () => {
    query.mockResolvedValueOnce({ rows: [{ status: 'signed_off' }] });

    await expect(repository.insert(input())).rejects.toBeInstanceOf(
      QaRunNotOpenError,
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('throws QaAttachmentLimitReachedError at the cap and inserts nothing', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] })
      .mockResolvedValueOnce({ rows: [{ count: '5' }] });

    await expect(repository.insert(input())).rejects.toBeInstanceOf(
      QaAttachmentLimitReachedError,
    );
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('throws QaAttachmentItemGoneError when the item row is missing', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(repository.insert(input())).rejects.toBeInstanceOf(
      QaAttachmentItemGoneError,
    );
  });

  it('locks the run FOR SHARE before deleting, and refuses on a signed-off run', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'att-1' }] });

    await expect(repository.deleteById('run-1', 'att-1')).resolves.toEqual({
      id: 'att-1',
    });
    expect(String(query.mock.calls[0]?.[0])).toMatch(/FOR SHARE/);
    expect(String(query.mock.calls[1]?.[0])).toMatch(
      /DELETE FROM projects\.qa_run_item_attachments/,
    );

    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ status: 'signed_off' }] });
    await expect(
      repository.deleteById('run-1', 'att-1'),
    ).rejects.toBeInstanceOf(QaRunNotOpenError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns null when the attachment was already gone', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ status: 'open' }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(repository.deleteById('run-1', 'att-1')).resolves.toBeNull();
  });

  it('counts attachments per item', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { run_item_id: 'ri-1', count: '2' },
        { run_item_id: 'ri-2', count: '1' },
      ],
    });

    await expect(repository.countsByItem('run-1')).resolves.toEqual(
      new Map([
        ['ri-1', 2],
        ['ri-2', 1],
      ]),
    );
  });
});
