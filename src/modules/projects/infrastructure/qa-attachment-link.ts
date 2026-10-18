import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC links for the postgres driver's screenshot bytes.
 *
 * A link binds one storage path and one expiry instant under a key derived
 * from SESSION_SECRET with a fixed label. The label keeps this key apart from
 * the session cookie signature, so a link never doubles as a cookie. Rotating
 * SESSION_SECRET invalidates outstanding links, which live for five minutes
 * anyway.
 */

const LINK_KEY_LABEL = 'alphaci:qa-attachment-link:v1';
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

export function deriveQaAttachmentLinkKey(sessionSecret: string): Buffer {
  return createHmac('sha256', sessionSecret).update(LINK_KEY_LABEL).digest();
}

export function signQaAttachmentLink(
  key: Buffer,
  storagePath: string,
  expiresAtEpochSeconds: number,
): string {
  return createHmac('sha256', key)
    .update(`${storagePath}\n${expiresAtEpochSeconds}`)
    .digest('hex');
}

/** True only for an unexpired link whose signature matches in constant time. */
export function isValidQaAttachmentLink(
  key: Buffer,
  storagePath: string,
  expiresAtEpochSeconds: number,
  signature: string,
  nowEpochSeconds: number,
): boolean {
  if (!Number.isSafeInteger(expiresAtEpochSeconds)) {
    return false;
  }
  if (expiresAtEpochSeconds < nowEpochSeconds) {
    return false;
  }
  if (!SIGNATURE_PATTERN.test(signature)) {
    return false;
  }
  const expected = Buffer.from(
    signQaAttachmentLink(key, storagePath, expiresAtEpochSeconds),
    'hex',
  );
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
