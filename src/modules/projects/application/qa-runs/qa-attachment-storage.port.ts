/**
 * Where QA screenshot bytes live: a private object store the backend alone can
 * write to and read from. The application depends on this narrow shape; the
 * Supabase Storage implementation is infrastructure/qa-attachment-storage.ts.
 */

/** Signed URLs are valid for five minutes: long enough to render a page, short enough to leak little. */
export const QA_ATTACHMENT_URL_TTL_SECONDS = 5 * 60;

export const QA_ATTACHMENT_STORAGE = Symbol('QA_ATTACHMENT_STORAGE');

/** A storage call failed (not "not configured": that is isConfigured() === false). */
export class QaAttachmentStorageError extends Error {
  constructor(operation: string, detail: string) {
    super(`qa-attachments ${operation} failed: ${detail}`);
    this.name = 'QaAttachmentStorageError';
  }
}

export interface QaAttachmentStoragePort {
  /** False when the store is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset). */
  isConfigured(): boolean;
  /** Never overwrites: an existing object at `path` is an error. */
  upload(path: string, bytes: Buffer, contentType: string): Promise<void>;
  remove(paths: string[]): Promise<void>;
  /**
   * path -> signed URL (valid QA_ATTACHMENT_URL_TTL_SECONDS). A path that could
   * not be signed, for example because the object is gone, is left out.
   */
  signedUrls(paths: string[]): Promise<Map<string, string>>;
}
