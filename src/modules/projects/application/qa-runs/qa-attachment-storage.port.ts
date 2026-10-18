/**
 * Where QA screenshot bytes live: a private object store the backend alone can
 * write to and read from. The application depends on this narrow shape. Two
 * implementations sit behind it, chosen by STORAGE_DRIVER in
 * qa-attachment-storage.module.ts:
 *
 *   supabase  infrastructure/qa-attachment-storage.ts (Supabase Storage bucket)
 *   postgres  infrastructure/qa-attachment-storage.postgres.ts (bytea rows)
 */

/** Signed URLs are valid for five minutes: long enough to render a page, short enough to leak little. */
export const QA_ATTACHMENT_URL_TTL_SECONDS = 5 * 60;

/** Largest screenshot the store accepts, matching the 3 MB product cap. */
export const QA_ATTACHMENT_STORE_MAX_BYTES = 3 * 1024 * 1024;

export const QA_ATTACHMENT_STORAGE = Symbol('QA_ATTACHMENT_STORAGE');

/** A storage call failed (not "not configured": that is isConfigured() === false). */
export class QaAttachmentStorageError extends Error {
  constructor(operation: string, detail: string) {
    super(`qa-attachments ${operation} failed: ${detail}`);
    this.name = 'QaAttachmentStorageError';
  }
}

/** The bytes behind one stored attachment, as served to a signed link. */
export interface QaAttachmentObject {
  bytes: Buffer;
  contentType: string;
}

export interface QaAttachmentStoragePort {
  /** False when the store is not configured (Supabase keys unset, or no database for postgres). */
  isConfigured(): boolean;
  /** Never overwrites: an existing object at `path` is an error. */
  upload(path: string, bytes: Buffer, contentType: string): Promise<void>;
  remove(paths: string[]): Promise<void>;
  /**
   * path -> signed URL (valid QA_ATTACHMENT_URL_TTL_SECONDS). A path that could
   * not be signed, for example because the object is gone, is left out.
   */
  signedUrls(paths: string[]): Promise<Map<string, string>>;
  /**
   * The bytes behind a link minted by signedUrls(), or null when the link is
   * forged, expired, or names no object. Only the postgres driver serves links
   * itself; Supabase links are answered by Supabase, so this is always null
   * for that driver.
   */
  readSignedLink(
    path: string,
    expiresAtEpochSeconds: number,
    signature: string,
  ): Promise<QaAttachmentObject | null>;
}
