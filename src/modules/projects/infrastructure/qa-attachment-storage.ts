import { Injectable, Logger } from '@nestjs/common';

import { SupabaseService } from '#kernel/db/supabase/supabase.service.js';
import {
  QA_ATTACHMENT_URL_TTL_SECONDS,
  QaAttachmentStorageError,
  type QaAttachmentStoragePort,
} from '../application/qa-runs/qa-attachment-storage.port';

export const QA_ATTACHMENTS_BUCKET = 'qa-attachments';

/**
 * The private `qa-attachments` Supabase Storage bucket, reached with the
 * service role key. The bucket has no public access: bytes only leave through
 * signed URLs the backend hands out after its own role check.
 */
@Injectable()
export class QaAttachmentStorage implements QaAttachmentStoragePort {
  private readonly logger = new Logger(QaAttachmentStorage.name);

  constructor(private readonly supabase: SupabaseService) {}

  /** False when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. */
  isConfigured(): boolean {
    return this.supabase.getClient() !== null;
  }

  async upload(
    path: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<void> {
    const { error } = await this.bucket().upload(path, bytes, {
      contentType,
      upsert: false,
    });
    if (error) {
      throw new QaAttachmentStorageError('upload', error.message);
    }
  }

  async remove(paths: string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }
    const { error } = await this.bucket().remove(paths);
    if (error) {
      throw new QaAttachmentStorageError('remove', error.message);
    }
  }

  /**
   * path -> signed URL. A path Storage could not sign (for example the object
   * is gone) is left out of the map and logged; the caller decides what that
   * means for the attachment.
   */
  async signedUrls(paths: string[]): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    if (paths.length === 0) {
      return urls;
    }
    const { data, error } = await this.bucket().createSignedUrls(
      paths,
      QA_ATTACHMENT_URL_TTL_SECONDS,
    );
    if (error) {
      throw new QaAttachmentStorageError('sign', error.message);
    }
    for (const entry of data) {
      if (entry.error || !entry.signedUrl || !entry.path) {
        this.logger.warn(
          `Could not sign ${entry.path ?? 'an attachment'}: ${entry.error ?? 'no URL returned'}`,
        );
        continue;
      }
      urls.set(entry.path, entry.signedUrl);
    }
    return urls;
  }

  private bucket() {
    const client = this.supabase.getClient();
    if (!client) {
      throw new QaAttachmentStorageError('access', 'storage is not configured');
    }
    return client.storage.from(QA_ATTACHMENTS_BUCKET);
  }
}
