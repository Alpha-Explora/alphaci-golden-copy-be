import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { DatabaseService } from '#kernel/db/database.service.js';
import {
  QA_ATTACHMENT_STORE_MAX_BYTES,
  QA_ATTACHMENT_URL_TTL_SECONDS,
  QaAttachmentStorageError,
} from '../application/qa-runs/qa-attachment-storage.port';
import {
  deriveQaAttachmentLinkKey,
  isValidQaAttachmentLink,
  signQaAttachmentLink,
} from './qa-attachment-link';
import { PostgresQaAttachmentStorage } from './qa-attachment-storage.postgres';

const SESSION_SECRET = 'x'.repeat(32);
const PATH = 'run-1/item-1/att-1.png';

function setup(options: { enabled?: boolean } = {}) {
  const query = jest.fn().mockResolvedValue({ rows: [] });
  const database = {
    query,
    isEnabled: jest.fn().mockReturnValue(options.enabled ?? true),
  } as unknown as DatabaseService;
  const config = {
    getOrThrow: jest.fn().mockReturnValue({
      session: { secret: SESSION_SECRET },
    }),
  } as unknown as ConfigService;
  const storage = new PostgresQaAttachmentStorage(database, config);
  return { storage, query, database };
}

describe('PostgresQaAttachmentStorage', () => {
  const originalPublicUrl = process.env['PLATFORM_PUBLIC_URL'];

  beforeEach(() => {
    process.env['PLATFORM_PUBLIC_URL'] = 'https://alphaci.customer.example';
  });

  afterEach(() => {
    if (originalPublicUrl === undefined) {
      delete process.env['PLATFORM_PUBLIC_URL'];
    } else {
      process.env['PLATFORM_PUBLIC_URL'] = originalPublicUrl;
    }
    jest.restoreAllMocks();
  });

  describe('isConfigured', () => {
    it('follows whether the database pool is enabled', () => {
      expect(setup({ enabled: true }).storage.isConfigured()).toBe(true);
      expect(setup({ enabled: false }).storage.isConfigured()).toBe(false);
    });
  });

  describe('upload', () => {
    it('stores the bytes with their type and size as one insert', async () => {
      const { storage, query } = setup();
      const bytes = Buffer.from('png-bytes');

      await storage.upload(PATH, bytes, 'image/png');

      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO projects.qa_attachment_objects');
      expect(params).toEqual([PATH, 'image/png', bytes.length, bytes]);
    });

    it('rejects an object over the size cap before touching the database', async () => {
      const { storage, query } = setup();
      const oversize = Buffer.alloc(QA_ATTACHMENT_STORE_MAX_BYTES + 1);

      await expect(
        storage.upload(PATH, oversize, 'image/png'),
      ).rejects.toBeInstanceOf(QaAttachmentStorageError);
      expect(query).not.toHaveBeenCalled();
    });

    it('accepts an object exactly at the cap', async () => {
      const { storage, query } = setup();

      await storage.upload(
        PATH,
        Buffer.alloc(QA_ATTACHMENT_STORE_MAX_BYTES),
        'image/png',
      );

      expect(query).toHaveBeenCalledTimes(1);
    });

    it('rejects an empty object', async () => {
      const { storage, query } = setup();

      await expect(
        storage.upload(PATH, Buffer.alloc(0), 'image/png'),
      ).rejects.toBeInstanceOf(QaAttachmentStorageError);
      expect(query).not.toHaveBeenCalled();
    });

    it('never overwrites: a unique violation is reported as an existing object', async () => {
      const { storage, query } = setup();
      query.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      );

      await expect(
        storage.upload(PATH, Buffer.from('x'), 'image/png'),
      ).rejects.toThrow(/already exists/);
    });

    it('wraps other database failures as a storage error', async () => {
      const { storage, query } = setup();
      query.mockRejectedValueOnce(new ServiceUnavailableException('down'));

      await expect(
        storage.upload(PATH, Buffer.from('x'), 'image/png'),
      ).rejects.toBeInstanceOf(QaAttachmentStorageError);
    });
  });

  describe('remove', () => {
    it('does nothing for an empty list', async () => {
      const { storage, query } = setup();

      await storage.remove([]);

      expect(query).not.toHaveBeenCalled();
    });

    it('deletes the named objects in one statement', async () => {
      const { storage, query } = setup();

      await storage.remove([PATH, 'other']);

      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('DELETE FROM projects.qa_attachment_objects');
      expect(params).toEqual([[PATH, 'other']]);
    });

    it('surfaces a failure as a storage error', async () => {
      const { storage, query } = setup();
      query.mockRejectedValueOnce(new Error('boom'));

      await expect(storage.remove([PATH])).rejects.toBeInstanceOf(
        QaAttachmentStorageError,
      );
    });
  });

  describe('signedUrls', () => {
    it('returns an empty map without querying for no paths', async () => {
      const { storage, query } = setup();

      await expect(storage.signedUrls([])).resolves.toEqual(new Map());
      expect(query).not.toHaveBeenCalled();
    });

    it('signs only the paths that have a stored object, under the public URL', async () => {
      const { storage, query } = setup();
      query.mockResolvedValueOnce({
        rows: [{ storage_path: PATH }],
      });

      const urls = await storage.signedUrls([PATH, 'gone/x.png']);

      expect(urls.has('gone/x.png')).toBe(false);
      const url = new URL(urls.get(PATH) as string);
      expect(url.origin + url.pathname).toBe(
        'https://alphaci.customer.example/api/v1/qa-attachments/content',
      );
      expect(url.searchParams.get('path')).toBe(PATH);

      const exp = Number(url.searchParams.get('exp'));
      const now = Math.floor(Date.now() / 1000);
      expect(exp).toBeGreaterThanOrEqual(
        now + QA_ATTACHMENT_URL_TTL_SECONDS - 5,
      );
      expect(exp).toBeLessThanOrEqual(now + QA_ATTACHMENT_URL_TTL_SECONDS + 5);

      const key = deriveQaAttachmentLinkKey(SESSION_SECRET);
      expect(
        isValidQaAttachmentLink(
          key,
          PATH,
          exp,
          url.searchParams.get('sig') as string,
          now,
        ),
      ).toBe(true);
    });
  });

  describe('readSignedLink', () => {
    /** Mints a link the way the app does, and returns the parts the route receives. */
    async function mintLink(path: string) {
      const { storage, query } = setup();
      query.mockResolvedValueOnce({ rows: [{ storage_path: path }] });
      const urls = await storage.signedUrls([path]);
      const url = new URL(urls.get(path) as string);
      return {
        exp: Number(url.searchParams.get('exp')),
        sig: url.searchParams.get('sig') as string,
      };
    }

    it('returns the bytes behind a valid, unexpired link', async () => {
      const { storage, query } = setup();
      const { exp, sig } = await mintLink(PATH);
      const bytes = Buffer.from('png-bytes');
      query.mockResolvedValueOnce({
        rows: [{ content_type: 'image/png', bytes }],
      });

      await expect(storage.readSignedLink(PATH, exp, sig)).resolves.toEqual({
        bytes,
        contentType: 'image/png',
      });
    });

    it('refuses a tampered path without reading the database', async () => {
      const { storage, query } = setup();
      const { exp, sig } = await mintLink(PATH);
      query.mockClear();

      await expect(
        storage.readSignedLink('someone-else.png', exp, sig),
      ).resolves.toBeNull();
      expect(query).not.toHaveBeenCalled();
    });

    it('refuses an expired link without reading the database', async () => {
      const { storage, query } = setup();
      const expired = Math.floor(Date.now() / 1000) - 1;
      const key = deriveQaAttachmentLinkKey(SESSION_SECRET);
      const sig = signQaAttachmentLink(key, PATH, expired);
      query.mockClear();

      await expect(
        storage.readSignedLink(PATH, expired, sig),
      ).resolves.toBeNull();
      expect(query).not.toHaveBeenCalled();
    });

    it('refuses a forged signature', async () => {
      const { storage, query } = setup();
      const { exp } = await mintLink(PATH);
      query.mockClear();

      await expect(
        storage.readSignedLink(PATH, exp, 'f'.repeat(64)),
      ).resolves.toBeNull();
      expect(query).not.toHaveBeenCalled();
    });

    it('returns null when the signed object no longer exists', async () => {
      const { storage, query } = setup();
      const { exp, sig } = await mintLink(PATH);
      query.mockResolvedValueOnce({ rows: [] });

      await expect(storage.readSignedLink(PATH, exp, sig)).resolves.toBeNull();
    });
  });
});
