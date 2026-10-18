import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config.js';
import { resolvePlatformBaseUrl } from '#kernel/config/ci-api-base-url.js';
import { DatabaseService } from '#kernel/db/database.service.js';
import {
  QA_ATTACHMENT_STORE_MAX_BYTES,
  QA_ATTACHMENT_URL_TTL_SECONDS,
  QaAttachmentStorageError,
  type QaAttachmentObject,
  type QaAttachmentStoragePort,
} from '../application/qa-runs/qa-attachment-storage.port';
import {
  deriveQaAttachmentLinkKey,
  isValidQaAttachmentLink,
  signQaAttachmentLink,
} from './qa-attachment-link';

/** Route that serves the bytes behind a signed link (see QaAttachmentContentController). */
export const QA_ATTACHMENT_CONTENT_PATH = '/api/v1/qa-attachments/content';

const UNIQUE_VIOLATION = '23505';

/**
 * QA screenshot bytes in projects.qa_attachment_objects (bytea), for
 * deployments without Supabase (STORAGE_DRIVER=postgres, the self-hosted
 * default).
 *
 * Browsers get bytes through the backend, never a raw table: signedUrls() mints
 * an HMAC link to QA_ATTACHMENT_CONTENT_PATH, and readSignedLink() checks that
 * link before any row is read. The size cap is enforced here and by a CHECK in
 * the migration, so an oversize write fails whichever side is reached first.
 */
@Injectable()
export class PostgresQaAttachmentStorage implements QaAttachmentStoragePort {
  private readonly logger = new Logger(PostgresQaAttachmentStorage.name);
  private readonly linkKey: Buffer;

  constructor(
    private readonly database: DatabaseService,
    configService: ConfigService,
  ) {
    this.linkKey = deriveQaAttachmentLinkKey(
      configService.getOrThrow<AppConfig>('app').session.secret,
    );
  }

  /** False when no DATABASE_URL is configured, so the UI hides attach controls. */
  isConfigured(): boolean {
    return this.database.isEnabled();
  }

  async upload(
    path: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<void> {
    if (bytes.length === 0 || bytes.length > QA_ATTACHMENT_STORE_MAX_BYTES) {
      throw new QaAttachmentStorageError(
        'upload',
        `an object must be 1 to ${QA_ATTACHMENT_STORE_MAX_BYTES} bytes (got ${bytes.length})`,
      );
    }
    try {
      await this.database.query(
        `INSERT INTO projects.qa_attachment_objects
           (storage_path, content_type, byte_size, bytes)
         VALUES ($1, $2, $3, $4)`,
        [path, contentType, bytes.length, bytes],
      );
    } catch (error) {
      if (errorCode(error) === UNIQUE_VIOLATION) {
        throw new QaAttachmentStorageError(
          'upload',
          'an object already exists at this path',
        );
      }
      throw new QaAttachmentStorageError('upload', messageOf(error));
    }
  }

  async remove(paths: string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }
    try {
      await this.database.query(
        'DELETE FROM projects.qa_attachment_objects WHERE storage_path = ANY($1::text[])',
        [paths],
      );
    } catch (error) {
      throw new QaAttachmentStorageError('remove', messageOf(error));
    }
  }

  /**
   * path -> signed link. A path with no stored object is left out and logged,
   * matching the Supabase adapter's "could not sign" behaviour.
   */
  async signedUrls(paths: string[]): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    if (paths.length === 0) {
      return urls;
    }

    let present: Set<string>;
    try {
      const result = await this.database.query<{ storage_path: string }>(
        'SELECT storage_path FROM projects.qa_attachment_objects WHERE storage_path = ANY($1::text[])',
        [paths],
      );
      present = new Set(result.rows.map((row) => row.storage_path));
    } catch (error) {
      throw new QaAttachmentStorageError('sign', messageOf(error));
    }

    const base = resolvePlatformBaseUrl();
    const expiresAt =
      Math.floor(Date.now() / 1000) + QA_ATTACHMENT_URL_TTL_SECONDS;
    for (const path of paths) {
      if (!present.has(path)) {
        this.logger.warn(`Could not sign ${path}: no stored object`);
        continue;
      }
      const signature = signQaAttachmentLink(this.linkKey, path, expiresAt);
      const query = new URLSearchParams({
        path,
        exp: String(expiresAt),
        sig: signature,
      });
      urls.set(
        path,
        `${base}${QA_ATTACHMENT_CONTENT_PATH}?${query.toString()}`,
      );
    }
    return urls;
  }

  async readSignedLink(
    path: string,
    expiresAtEpochSeconds: number,
    signature: string,
  ): Promise<QaAttachmentObject | null> {
    const now = Math.floor(Date.now() / 1000);
    if (
      !isValidQaAttachmentLink(
        this.linkKey,
        path,
        expiresAtEpochSeconds,
        signature,
        now,
      )
    ) {
      return null;
    }

    const result = await this.database.query<{
      content_type: string;
      bytes: Buffer;
    }>(
      'SELECT content_type, bytes FROM projects.qa_attachment_objects WHERE storage_path = $1',
      [path],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return { bytes: row.bytes, contentType: row.content_type };
  }
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
