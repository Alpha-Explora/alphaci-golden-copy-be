import type { SupabaseService } from '#kernel/db/supabase/supabase.service.js';
import {
  QA_ATTACHMENT_URL_TTL_SECONDS,
  QaAttachmentStorageError,
} from '../application/qa-runs/qa-attachment-storage.port';
import {
  QA_ATTACHMENTS_BUCKET,
  QaAttachmentStorage,
} from './qa-attachment-storage';

function setup(configured = true) {
  const bucket = {
    upload: jest.fn().mockResolvedValue({ data: {}, error: null }),
    remove: jest.fn().mockResolvedValue({ data: [], error: null }),
    createSignedUrls: jest.fn(),
  };
  const from = jest.fn().mockReturnValue(bucket);
  const client = { storage: { from } };
  const supabase = {
    getClient: jest.fn().mockReturnValue(configured ? client : null),
  } as unknown as SupabaseService;
  return { storage: new QaAttachmentStorage(supabase), bucket, from };
}

describe('QaAttachmentStorage', () => {
  it('reports whether the service client is configured', () => {
    expect(setup(true).storage.isConfigured()).toBe(true);
    expect(setup(false).storage.isConfigured()).toBe(false);
  });

  it('uploads to the private qa-attachments bucket without overwriting', async () => {
    const { storage, bucket, from } = setup();
    const bytes = Buffer.from('x');

    await storage.upload('run/item/id.png', bytes, 'image/png');

    expect(from).toHaveBeenCalledWith(QA_ATTACHMENTS_BUCKET);
    expect(QA_ATTACHMENTS_BUCKET).toBe('qa-attachments');
    expect(bucket.upload).toHaveBeenCalledWith('run/item/id.png', bytes, {
      contentType: 'image/png',
      upsert: false,
    });
  });

  it('throws a QaAttachmentStorageError when Storage reports an error', async () => {
    const { storage, bucket } = setup();
    bucket.upload.mockResolvedValue({
      data: null,
      error: { message: 'Bucket not found' },
    });

    await expect(
      storage.upload('p.png', Buffer.from('x'), 'image/png'),
    ).rejects.toBeInstanceOf(QaAttachmentStorageError);
  });

  it('throws when used while not configured', async () => {
    const { storage } = setup(false);

    await expect(
      storage.upload('p.png', Buffer.from('x'), 'image/png'),
    ).rejects.toBeInstanceOf(QaAttachmentStorageError);
  });

  it('signs URLs for five minutes and maps them by path, skipping paths it could not sign', async () => {
    const { storage, bucket } = setup();
    bucket.createSignedUrls.mockResolvedValue({
      data: [
        { path: 'a.png', signedUrl: 'https://s/a', error: null },
        { path: 'b.png', signedUrl: null, error: 'Object not found' },
      ],
      error: null,
    });

    const urls = await storage.signedUrls(['a.png', 'b.png']);

    expect(bucket.createSignedUrls).toHaveBeenCalledWith(
      ['a.png', 'b.png'],
      QA_ATTACHMENT_URL_TTL_SECONDS,
    );
    expect(QA_ATTACHMENT_URL_TTL_SECONDS).toBe(300);
    expect(urls).toEqual(new Map([['a.png', 'https://s/a']]));
  });

  it('does not call Storage to sign or remove nothing', async () => {
    const { storage, bucket } = setup();

    await expect(storage.signedUrls([])).resolves.toEqual(new Map());
    await storage.remove([]);

    expect(bucket.createSignedUrls).not.toHaveBeenCalled();
    expect(bucket.remove).not.toHaveBeenCalled();
  });

  it('removes objects and surfaces a failure', async () => {
    const { storage, bucket } = setup();
    await storage.remove(['a.png']);
    expect(bucket.remove).toHaveBeenCalledWith(['a.png']);

    bucket.remove.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(storage.remove(['a.png'])).rejects.toBeInstanceOf(
      QaAttachmentStorageError,
    );
  });

  it('never serves signed links itself: Supabase answers its own URLs', async () => {
    const { storage } = setup();

    await expect(storage.readSignedLink()).resolves.toBeNull();
  });
});
