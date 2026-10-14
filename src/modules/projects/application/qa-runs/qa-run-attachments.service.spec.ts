import { NotFoundException } from '@nestjs/common';

import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import {
  deliveredIterationRow,
  fakeIterations,
} from '../../__fixtures__/project-iterations';
import {
  jpegBytes,
  pngBytes,
  webpBytes,
} from '../../__fixtures__/qa-attachment-images';
import {
  QaAttachmentItemGoneError,
  QaAttachmentLimitReachedError,
  type QaRunAttachmentsRepository,
  type QaRunItemAttachmentRow,
} from '../../infrastructure/qa-run-attachments.repository';
import type { QaProjectRunsRepository } from '../../infrastructure/qa-project-runs.repository';
import {
  QaRunNotOpenError,
  type QaProjectRunRow,
  type QaRunItemRow,
  type QaRunsRepository,
} from '../../infrastructure/qa-runs.repository';
import type { ProjectIterationRow } from '../../infrastructure/project-iterations.repository';
import type { QaAccessService } from '../qa-checklists/qa-access.service';
import type {
  QaProjectContext,
  QaProjectContextService,
} from '../qa-checklists/qa-project-context.service';
import {
  QaAttachmentStorageError,
  type QaAttachmentStoragePort,
} from './qa-attachment-storage.port';
import { parseQaAttachmentFields } from './qa-attachments.fields';
import { QaRunAttachmentsService } from './qa-run-attachments.service';

const DP = 'dp-1';
const project: QaProjectContext = {
  deliveryProjectId: DP,
  groupId: 'group-1',
  name: 'Checkout',
  repositories: [],
};

const actor = (userId = 'qa-1', userLogin = 'qa') => ({
  userId,
  userLogin,
  oauthToken: 'tok',
});

const runRow = (status: 'open' | 'signed_off' = 'open'): QaProjectRunRow =>
  ({
    id: 'run-1',
    scope: 'project',
    delivery_project_id: DP,
    iteration_id: 'it-1',
    status,
  }) as QaProjectRunRow;

const itemRow = { id: 'ri-1', run_id: 'run-1' } as QaRunItemRow;

const attachmentRow = (
  overrides: Partial<QaRunItemAttachmentRow> = {},
): QaRunItemAttachmentRow => ({
  id: 'att-1',
  run_id: 'run-1',
  run_item_id: 'ri-1',
  kind: 'evidence',
  storage_path: 'run-1/ri-1/att-1.png',
  content_type: 'image/png',
  byte_size: 33,
  width: 1280,
  height: 720,
  caption: 'Receipt',
  source: 'upload',
  test_title: null,
  created_by: 'qa-1',
  created_by_login: 'qa',
  created_at: '2026-10-14T10:00:00.000Z',
  ...overrides,
});

function setup({
  role = 'qa',
  run = runRow(),
  configured = true,
  existing = [] as QaRunItemAttachmentRow[],
  iteration,
}: {
  role?: PlatformAppRole;
  run?: QaProjectRunRow | null;
  configured?: boolean;
  existing?: QaRunItemAttachmentRow[];
  iteration?: ProjectIterationRow;
} = {}) {
  const runs = {
    findItemForRun: jest
      .fn()
      .mockImplementation((_runId: string, itemId: string) =>
        Promise.resolve(itemId === itemRow.id ? itemRow : null),
      ),
  } as unknown as jest.Mocked<QaRunsRepository>;
  const projectRuns = {
    findProjectRun: jest.fn().mockResolvedValue(run),
  } as unknown as jest.Mocked<QaProjectRunsRepository>;
  const attachments = {
    insert: jest
      .fn()
      .mockImplementation(
        (input: {
          id: string;
          storagePath: string;
          caption: string | null;
          source: 'upload';
          width: number;
          height: number;
          byteSize: number;
          contentType: 'image/png';
        }) =>
          Promise.resolve(
            attachmentRow({
              id: input.id,
              storage_path: input.storagePath,
              caption: input.caption,
              width: input.width,
              height: input.height,
              byte_size: input.byteSize,
              content_type: input.contentType,
            }),
          ),
      ),
    deleteById: jest
      .fn()
      .mockImplementation((_run: string, id: string) =>
        Promise.resolve(existing.find((row) => row.id === id) ?? null),
      ),
    findForRun: jest
      .fn()
      .mockImplementation((_run: string, id: string) =>
        Promise.resolve(existing.find((row) => row.id === id) ?? null),
      ),
    listByItem: jest.fn().mockResolvedValue(existing),
    listByRun: jest.fn().mockResolvedValue(existing),
    countsByItem: jest.fn().mockResolvedValue(new Map()),
  } as unknown as jest.Mocked<QaRunAttachmentsRepository>;
  const storage = {
    isConfigured: jest.fn().mockReturnValue(configured),
    upload: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    signedUrls: jest
      .fn()
      .mockImplementation((paths: string[]) =>
        Promise.resolve(
          new Map(
            paths.map((path) => [path, `https://signed.example/${path}`]),
          ),
        ),
      ),
  } as unknown as jest.Mocked<QaAttachmentStoragePort>;
  const access = {
    findAppRole: jest.fn().mockResolvedValue(role),
  } as unknown as jest.Mocked<QaAccessService>;
  const projectContext = {
    requireProject: jest.fn().mockResolvedValue(project),
    anchorProjectId: jest.fn().mockResolvedValue('p-web'),
  } as unknown as jest.Mocked<QaProjectContextService>;
  const audit = { recordProjectEvent: jest.fn().mockResolvedValue(undefined) };

  const service = new QaRunAttachmentsService(
    runs,
    projectRuns,
    attachments,
    storage,
    access,
    projectContext,
    fakeIterations(iteration).service,
    audit,
  );
  return {
    service,
    runs,
    projectRuns,
    attachments,
    storage,
    access,
    projectContext,
    audit,
  };
}

const FIELDS = parseQaAttachmentFields({ caption: 'Receipt' });
const PNG = (): { buffer: Buffer; size: number } => {
  const buffer = pngBytes(1280, 720);
  return { buffer, size: buffer.length };
};

describe('QaRunAttachmentsService.add', () => {
  it.each(['qa', 'lead', 'admin'] as const)(
    'lets %s attach a screenshot, uploads to <run>/<item>/<id>.png and returns a signed URL',
    async (role) => {
      const { service, storage, attachments, audit } = setup({ role });

      const result = await service.add(
        DP,
        actor(),
        'run-1',
        'ri-1',
        PNG(),
        FIELDS,
      );

      const [path, bytes, contentType] = storage.upload.mock.calls[0] as [
        string,
        Buffer,
        string,
      ];
      expect(path).toMatch(/^run-1\/ri-1\/[0-9a-f-]{36}\.png$/);
      expect(bytes.length).toBe(33);
      expect(contentType).toBe('image/png');
      expect(attachments.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          runItemId: 'ri-1',
          kind: 'evidence',
          storagePath: path,
          contentType: 'image/png',
          width: 1280,
          height: 720,
          caption: 'Receipt',
          source: 'upload',
          createdBy: 'qa-1',
          createdByLogin: 'qa',
          maxHumanPerItem: 5,
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          kind: 'evidence',
          contentType: 'image/png',
          width: 1280,
          height: 720,
          url: `https://signed.example/${path}`,
          canDelete: true,
        }),
      );
      expect(new Date(result.urlExpiresAt).getTime()).toBeGreaterThan(
        Date.now() + 4 * 60 * 1000,
      );
      expect(audit.recordProjectEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventCode: 'qa.item.attachment_added',
          actorUserId: 'qa-1',
          metadata: expect.objectContaining({
            runId: 'run-1',
            itemId: 'ri-1',
            kind: 'evidence',
            uploadedBy: 'qa',
          }),
        }),
      );
    },
  );

  it.each(['member', 'viewer'] as const)(
    'refuses %s with QA_ATTACHMENT_FORBIDDEN and uploads nothing',
    async (role) => {
      const { service, storage } = setup({ role: role as PlatformAppRole });

      await expect(
        service.add(DP, actor(), 'run-1', 'ri-1', PNG(), FIELDS),
      ).rejects.toMatchObject({
        status: 403,
        response: expect.objectContaining({ code: 'QA_ATTACHMENT_FORBIDDEN' }),
      });
      expect(storage.upload).not.toHaveBeenCalled();
    },
  );

  it('answers 409 QA_RUN_SIGNED_OFF on a signed-off run before touching storage', async () => {
    const { service, storage } = setup({ run: runRow('signed_off') });

    await expect(
      service.add(DP, actor(), 'run-1', 'ri-1', PNG(), FIELDS),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'QA_RUN_SIGNED_OFF' }),
    });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('maps a sign-off that wins the lock race to QA_RUN_SIGNED_OFF and removes the object', async () => {
    const { service, storage, attachments } = setup();
    attachments.insert.mockRejectedValue(new QaRunNotOpenError('run-1'));

    await expect(
      service.add(DP, actor(), 'run-1', 'ri-1', PNG(), FIELDS),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'QA_RUN_SIGNED_OFF' }),
    });
    const [uploadedPath] = storage.upload.mock.calls[0] as [
      string,
      Buffer,
      string,
    ];
    expect(storage.remove).toHaveBeenCalledWith([uploadedPath]);
  });

  it('answers 503 QA_ATTACHMENTS_UNAVAILABLE when storage is not configured', async () => {
    const { service, storage } = setup({ configured: false });

    await expect(
      service.add(DP, actor(), 'run-1', 'ri-1', PNG(), FIELDS),
    ).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({
        code: 'QA_ATTACHMENTS_UNAVAILABLE',
      }),
    });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('answers 503 when the upload itself fails, and writes no row', async () => {
    const { service, storage, attachments } = setup();
    storage.upload.mockRejectedValue(
      new QaAttachmentStorageError('upload', 'bucket not found'),
    );

    await expect(
      service.add(DP, actor(), 'run-1', 'ri-1', PNG(), FIELDS),
    ).rejects.toMatchObject({ status: 503 });
    expect(attachments.insert).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown run, an unknown item and a Project the caller cannot see', async () => {
    const noRun = setup({ run: null });
    await expect(
      noRun.service.add(DP, actor(), 'nope', 'ri-1', PNG(), FIELDS),
    ).rejects.toMatchObject({ status: 404 });

    const noItem = setup();
    await expect(
      noItem.service.add(DP, actor(), 'run-1', 'ri-404', PNG(), FIELDS),
    ).rejects.toMatchObject({ status: 404 });
    expect(noItem.storage.upload).not.toHaveBeenCalled();

    const hidden = setup();
    hidden.projectContext.requireProject.mockRejectedValue(
      new NotFoundException('Project not found'),
    );
    await expect(
      hidden.service.add(DP, actor(), 'run-1', 'ri-1', PNG(), FIELDS),
    ).rejects.toMatchObject({ status: 404 });
    expect(hidden.storage.upload).not.toHaveBeenCalled();
  });

  describe('byte checks', () => {
    it('rejects a PNG that is really text with 415 QA_ATTACHMENT_TYPE, ignoring the declared type', async () => {
      const { service, storage } = setup();
      const buffer = Buffer.from('definitely not a png, just text');

      await expect(
        service.add(
          DP,
          actor(),
          'run-1',
          'ri-1',
          { buffer, size: buffer.length },
          FIELDS,
        ),
      ).rejects.toMatchObject({
        status: 415,
        response: expect.objectContaining({ code: 'QA_ATTACHMENT_TYPE' }),
      });
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('rejects more than 3 MB with 413 QA_ATTACHMENT_TOO_LARGE', async () => {
      const { service } = setup();
      const buffer = Buffer.concat([
        pngBytes(100, 100),
        Buffer.alloc(3 * 1024 * 1024),
      ]);

      await expect(
        service.add(
          DP,
          actor(),
          'run-1',
          'ri-1',
          { buffer, size: buffer.length },
          FIELDS,
        ),
      ).rejects.toMatchObject({
        status: 413,
        response: expect.objectContaining({
          code: 'QA_ATTACHMENT_TOO_LARGE',
        }),
      });
    });

    it('accepts exactly 3 MB', async () => {
      const { service } = setup();
      const header = pngBytes(100, 100);
      const buffer = Buffer.concat([
        header,
        Buffer.alloc(3 * 1024 * 1024 - header.length),
      ]);
      expect(buffer.length).toBe(3 * 1024 * 1024);

      await expect(
        service.add(
          DP,
          actor(),
          'run-1',
          'ri-1',
          { buffer, size: buffer.length },
          FIELDS,
        ),
      ).resolves.toBeDefined();
    });

    it.each([
      ['wide', 8001, 100],
      ['tall', 100, 8001],
    ])('rejects a %s image over 8000 px with 413', async (_name, w, h) => {
      const { service } = setup();
      const buffer = pngBytes(w, h);

      await expect(
        service.add(
          DP,
          actor(),
          'run-1',
          'ri-1',
          { buffer, size: buffer.length },
          FIELDS,
        ),
      ).rejects.toMatchObject({
        status: 413,
        response: expect.objectContaining({
          code: 'QA_ATTACHMENT_TOO_LARGE',
        }),
      });
    });

    it('accepts 8000x8000, and stores jpeg and webp with their real type and extension', async () => {
      const { service, storage, attachments } = setup();
      await service.add(
        DP,
        actor(),
        'run-1',
        'ri-1',
        { buffer: pngBytes(8000, 8000), size: 1 },
        FIELDS,
      );
      const jpeg = jpegBytes(640, 480);
      await service.add(
        DP,
        actor(),
        'run-1',
        'ri-1',
        { buffer: jpeg, size: jpeg.length },
        FIELDS,
      );
      const webp = webpBytes('lossy', 320, 200);
      await service.add(
        DP,
        actor(),
        'run-1',
        'ri-1',
        { buffer: webp, size: webp.length },
        FIELDS,
      );

      const paths = storage.upload.mock.calls.map((call) => call[0]);
      expect(paths[0]).toMatch(/\.png$/);
      expect(paths[1]).toMatch(/\.jpg$/);
      expect(paths[2]).toMatch(/\.webp$/);
      expect(attachments.insert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          contentType: 'image/webp',
          width: 320,
          height: 200,
        }),
      );
    });

    it('requires a file', async () => {
      const { service } = setup();

      await expect(
        service.add(DP, actor(), 'run-1', 'ri-1', undefined, FIELDS),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('limit', () => {
    const humans = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        attachmentRow({ id: `att-${i}`, storage_path: `p/${i}.png` }),
      );

    it('answers 409 QA_ATTACHMENT_LIMIT at five human attachments, before uploading', async () => {
      const { service, storage } = setup({ existing: humans(5) });

      await expect(
        service.add(DP, actor(), 'run-1', 'ri-1', PNG(), FIELDS),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: 'QA_ATTACHMENT_LIMIT' }),
      });
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('does not count automated attachments toward the cap', async () => {
      const { service } = setup({
        existing: [
          ...humans(4),
          attachmentRow({ id: 'auto', kind: 'automated', created_by: null }),
          attachmentRow({ id: 'auto2', kind: 'automated', created_by: null }),
        ],
      });

      await expect(
        service.add(DP, actor(), 'run-1', 'ri-1', PNG(), FIELDS),
      ).resolves.toBeDefined();
    });

    it('maps the locked re-check (a concurrent upload won) to 409 and removes the object', async () => {
      const { service, storage, attachments } = setup();
      attachments.insert.mockRejectedValue(
        new QaAttachmentLimitReachedError(5),
      );

      await expect(
        service.add(DP, actor(), 'run-1', 'ri-1', PNG(), FIELDS),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: 'QA_ATTACHMENT_LIMIT' }),
      });
      expect(storage.remove).toHaveBeenCalledTimes(1);
    });
  });

  describe('orphan cleanup', () => {
    it('removes the uploaded object when the insert fails, and rethrows the failure', async () => {
      const { service, storage, attachments } = setup();
      attachments.insert.mockRejectedValue(new Error('connection reset'));

      await expect(
        service.add(DP, actor(), 'run-1', 'ri-1', PNG(), FIELDS),
      ).rejects.toThrow('connection reset');
      const [uploadedPath] = storage.upload.mock.calls[0] as [
        string,
        Buffer,
        string,
      ];
      expect(storage.remove).toHaveBeenCalledWith([uploadedPath]);
    });

    it('still reports the real failure when removing the orphan also fails', async () => {
      const { service, storage, attachments } = setup();
      attachments.insert.mockRejectedValue(
        new QaAttachmentItemGoneError('ri-1'),
      );
      storage.remove.mockRejectedValue(
        new QaAttachmentStorageError('remove', 'down'),
      );

      await expect(
        service.add(DP, actor(), 'run-1', 'ri-1', PNG(), FIELDS),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});

describe('QaRunAttachmentsService.remove', () => {
  const mine = attachmentRow({ id: 'mine', created_by: 'qa-1' });
  const theirs = attachmentRow({
    id: 'theirs',
    created_by: 'qa-2',
    created_by_login: 'other',
    storage_path: 'run-1/ri-1/theirs.png',
  });
  const automated = attachmentRow({
    id: 'auto',
    kind: 'automated',
    created_by: null,
    created_by_login: null,
  });

  it('lets the uploader delete their own: row first, then the object, with an audit event', async () => {
    const { service, attachments, storage, audit } = setup({
      existing: [mine],
    });
    const order: string[] = [];
    attachments.deleteById.mockImplementation(() => {
      order.push('row');
      return Promise.resolve(mine);
    });
    storage.remove.mockImplementation(() => {
      order.push('object');
      return Promise.resolve();
    });

    await service.remove(DP, actor('qa-1'), 'run-1', 'mine');

    expect(order).toEqual(['row', 'object']);
    expect(storage.remove).toHaveBeenCalledWith([mine.storage_path]);
    expect(audit.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCode: 'qa.item.attachment_removed',
        metadata: expect.objectContaining({
          attachmentId: 'mine',
          removedBy: 'qa',
        }),
      }),
    );
  });

  it.each(['lead', 'admin'] as const)(
    "lets %s delete someone else's attachment",
    async (role) => {
      const { service, attachments } = setup({ role, existing: [theirs] });

      await service.remove(DP, actor('lead-1', 'lead'), 'run-1', 'theirs');

      expect(attachments.deleteById).toHaveBeenCalledWith('run-1', 'theirs');
    },
  );

  it('refuses a qa who is not the uploader with 403 QA_ATTACHMENT_FORBIDDEN', async () => {
    const { service, attachments } = setup({ existing: [theirs] });

    await expect(
      service.remove(DP, actor('qa-1'), 'run-1', 'theirs'),
    ).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ code: 'QA_ATTACHMENT_FORBIDDEN' }),
    });
    expect(attachments.deleteById).not.toHaveBeenCalled();
  });

  it('never lets anyone, lead included, delete an automated attachment by hand', async () => {
    const { service, attachments } = setup({
      role: 'lead',
      existing: [automated],
    });

    await expect(
      service.remove(DP, actor('lead-1', 'lead'), 'run-1', 'auto'),
    ).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ code: 'QA_ATTACHMENT_FORBIDDEN' }),
    });
    expect(attachments.deleteById).not.toHaveBeenCalled();
  });

  it('answers 409 QA_RUN_SIGNED_OFF on a signed-off run', async () => {
    const { service, attachments } = setup({
      run: runRow('signed_off'),
      existing: [mine],
    });

    await expect(
      service.remove(DP, actor('qa-1'), 'run-1', 'mine'),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'QA_RUN_SIGNED_OFF' }),
    });
    expect(attachments.deleteById).not.toHaveBeenCalled();
  });

  it('maps a sign-off that wins the lock race to 409', async () => {
    const { service, attachments } = setup({ existing: [mine] });
    attachments.deleteById.mockRejectedValue(new QaRunNotOpenError('run-1'));

    await expect(
      service.remove(DP, actor('qa-1'), 'run-1', 'mine'),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'QA_RUN_SIGNED_OFF' }),
    });
  });

  it('answers 404 for an unknown attachment', async () => {
    const { service } = setup({ existing: [] });

    await expect(
      service.remove(DP, actor(), 'run-1', 'nope'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('does not fail the delete when removing the object fails (the row is already gone)', async () => {
    const { service, storage, audit } = setup({ existing: [mine] });
    storage.remove.mockRejectedValue(
      new QaAttachmentStorageError('remove', 'down'),
    );

    await expect(
      service.remove(DP, actor('qa-1'), 'run-1', 'mine'),
    ).resolves.toBeUndefined();
    expect(audit.recordProjectEvent).toHaveBeenCalledTimes(1);
  });
});

describe('QaRunAttachmentsService reads', () => {
  const rows = [
    attachmentRow({ id: 'new', storage_path: 'run-1/ri-1/new.png' }),
    attachmentRow({
      id: 'old',
      storage_path: 'run-1/ri-1/old.png',
      created_by: 'qa-2',
      created_by_login: 'other',
    }),
  ];

  it('lists every attachment of the run with signed URLs and per-caller canDelete', async () => {
    const { service, storage } = setup({ role: 'qa', existing: rows });

    const { items } = await service.listForRun(DP, actor('qa-1'), 'run-1');

    expect(storage.signedUrls).toHaveBeenCalledWith([
      'run-1/ri-1/new.png',
      'run-1/ri-1/old.png',
    ]);
    expect(items.map((item) => [item.id, item.canDelete])).toEqual([
      ['new', true],
      ['old', false],
    ]);
    expect(items[0]?.url).toBe('https://signed.example/run-1/ri-1/new.png');
  });

  it('lets a developer (member) read but never delete', async () => {
    const { service } = setup({ role: 'member', existing: rows });

    const { items } = await service.listForRun(DP, actor('dev-1'), 'run-1');

    expect(items).toHaveLength(2);
    expect(items.every((item) => !item.canDelete)).toBe(true);
  });

  it('reports canDelete false for everything on a signed-off run', async () => {
    const { service } = setup({
      role: 'lead',
      run: runRow('signed_off'),
      existing: rows,
    });

    const { items } = await service.listForRun(DP, actor('lead-1'), 'run-1');

    expect(items.every((item) => !item.canDelete)).toBe(true);
  });

  it('lists one item newest first (the repository orders), 404 for an unknown item', async () => {
    const { service, attachments } = setup({ existing: rows });

    const { items } = await service.listForItem(DP, actor(), 'run-1', 'ri-1');
    expect(attachments.listByItem).toHaveBeenCalledWith('run-1', 'ri-1');
    expect(items.map((item) => item.id)).toEqual(['new', 'old']);

    await expect(
      service.listForItem(DP, actor(), 'run-1', 'ri-404'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('answers an empty list without needing storage when there is nothing attached', async () => {
    const { service, storage } = setup({ configured: false, existing: [] });

    await expect(service.listForRun(DP, actor(), 'run-1')).resolves.toEqual({
      items: [],
    });
    expect(storage.signedUrls).not.toHaveBeenCalled();
  });

  it('answers 503 when rows exist but storage is not configured', async () => {
    const { service } = setup({ configured: false, existing: rows });

    await expect(
      service.listForRun(DP, actor(), 'run-1'),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('leaves out an attachment whose object cannot be signed instead of failing the page', async () => {
    const { service, storage } = setup({ existing: rows });
    storage.signedUrls.mockResolvedValue(
      new Map([['run-1/ri-1/new.png', 'https://signed.example/new']]),
    );

    const { items } = await service.listForRun(DP, actor(), 'run-1');

    expect(items.map((item) => item.id)).toEqual(['new']);
  });

  it('builds report references (ids and captions, no URLs), oldest first per item', async () => {
    const { service } = setup({ existing: rows });

    const refs = await service.referencesForRun('run-1');

    expect(refs.get('ri-1')).toEqual([
      {
        id: 'old',
        caption: 'Receipt',
        kind: 'evidence',
        contentType: 'image/png',
      },
      {
        id: 'new',
        caption: 'Receipt',
        kind: 'evidence',
        contentType: 'image/png',
      },
    ]);
  });

  it('reports isEnabled from the storage configuration', () => {
    expect(setup({ configured: true }).service.isEnabled()).toBe(true);
    expect(setup({ configured: false }).service.isEnabled()).toBe(false);
  });
});

/** What a sync function throws, or undefined when it does not. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('parseQaAttachmentFields', () => {
  it('defaults to an uncaptioned upload of kind evidence', () => {
    expect(parseQaAttachmentFields({})).toEqual({
      kind: 'evidence',
      source: 'upload',
      caption: null,
    });
    expect(parseQaAttachmentFields(undefined)).toEqual({
      kind: 'evidence',
      source: 'upload',
      caption: null,
    });
  });

  it('trims the caption and accepts capture and paste', () => {
    expect(
      parseQaAttachmentFields({ caption: '  Receipt  ', source: 'paste' }),
    ).toEqual({ kind: 'evidence', source: 'paste', caption: 'Receipt' });
    expect(parseQaAttachmentFields({ source: 'capture' }).source).toBe(
      'capture',
    );
  });

  it('turns a blank caption into null and allows exactly 280 characters', () => {
    expect(parseQaAttachmentFields({ caption: '   ' }).caption).toBeNull();
    expect(
      parseQaAttachmentFields({ caption: 'x'.repeat(280) }).caption,
    ).toHaveLength(280);
  });

  it('rejects a caption over 280 characters with 400', () => {
    expect(
      thrown(() => parseQaAttachmentFields({ caption: 'x'.repeat(281) })),
    ).toMatchObject({
      status: 400,
    });
  });

  it.each(['fix_proof', 'automated', 'nonsense'])(
    'rejects kind %s with 400 QA_ATTACHMENT_KIND',
    (kind) => {
      expect(thrown(() => parseQaAttachmentFields({ kind }))).toMatchObject({
        status: 400,
        response: { code: 'QA_ATTACHMENT_KIND' },
      });
    },
  );

  it('rejects source playwright (CI-only) and unknown sources with 400', () => {
    expect(
      thrown(() => parseQaAttachmentFields({ source: 'playwright' })),
    ).toMatchObject({ status: 400 });
    expect(
      thrown(() => parseQaAttachmentFields({ source: 'fax' })),
    ).toMatchObject({ status: 400 });
  });
});

describe('QaRunAttachmentsService - delivered Iteration', () => {
  const delivered = deliveredIterationRow({ number: 4 });
  const GUARD = {
    status: 409,
    response: expect.objectContaining({
      code: 'ITERATION_DELIVERED',
      message:
        'Iteration 4 was delivered. Start the next iteration to change this.',
    }),
  };

  it('add is refused before touching storage', async () => {
    const { service, storage, attachments } = setup({
      iteration: delivered,
      run: { ...runRow('signed_off'), iteration_id: delivered.id },
    });

    await expect(
      service.add(DP, actor(), 'run-1', 'ri-1', PNG(), FIELDS),
    ).rejects.toMatchObject(GUARD);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(attachments.insert).not.toHaveBeenCalled();
  });

  it('remove is refused', async () => {
    const mine = attachmentRow({ id: 'mine', created_by: 'qa-1' });
    const { service, attachments } = setup({
      iteration: delivered,
      run: { ...runRow('signed_off'), iteration_id: delivered.id },
      existing: [mine],
    });

    await expect(
      service.remove(DP, actor('qa-1'), 'run-1', 'mine'),
    ).rejects.toMatchObject(GUARD);
    expect(attachments.deleteById).not.toHaveBeenCalled();
  });

  it('reads still work: the screenshots of a delivered Iteration stay visible', async () => {
    const { service } = setup({
      iteration: delivered,
      run: { ...runRow('signed_off'), iteration_id: delivered.id },
      existing: [attachmentRow()],
    });

    const list = await service.listForRun(DP, actor(), 'run-1');

    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.canDelete).toBe(false);
  });
});
