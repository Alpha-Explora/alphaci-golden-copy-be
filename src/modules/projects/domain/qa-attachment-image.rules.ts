/**
 * Reads what an uploaded screenshot really is from its bytes: the format from
 * the magic number, the pixel size from the header. The declared content type
 * and file name are never consulted (same approach as the visual-testing PNG
 * check). Plain functions, no dependencies: data in, data out.
 *
 * Only headers are parsed; the image is never decoded, so a hostile file can at
 * worst make a parse return null.
 */

export const QA_ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;
export const QA_ATTACHMENT_MAX_DIMENSION = 8000;

export type QaAttachmentContentType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface QaAttachmentImageInfo {
  contentType: QaAttachmentContentType;
  /** File extension without the dot, used in the storage path. */
  extension: 'png' | 'jpg' | 'webp';
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function readPng(bytes: Buffer): QaAttachmentImageInfo | null {
  // Signature (8) + IHDR chunk: length (4), "IHDR" (4), width (4), height (4).
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') {
    return null;
  }
  return {
    contentType: 'image/png',
    extension: 'png',
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

/** Start-of-frame markers carry the size; C4 (DHT), C8 (JPG) and CC (DAC) share the range but are not frames. */
function isStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
  );
}

function readJpeg(bytes: Buffer): QaAttachmentImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    const marker = bytes[offset + 1] as number;
    if (marker === 0xff) {
      // Fill byte before a marker.
      offset += 1;
      continue;
    }
    // Standalone markers (no length): TEM, RSTn, SOI, EOI.
    if (
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd9) ||
      marker === 0x00
    ) {
      offset += 2;
      continue;
    }
    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (segmentLength < 2) {
      return null;
    }
    if (isStartOfFrame(marker)) {
      // length (2) + precision (1) + height (2) + width (2)
      if (offset + 9 > bytes.length) {
        return null;
      }
      return {
        contentType: 'image/jpeg',
        extension: 'jpg',
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function readWebp(bytes: Buffer): QaAttachmentImageInfo | null {
  if (
    bytes.length < 30 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null;
  }
  const fourcc = bytes.toString('ascii', 12, 16);
  let width: number;
  let height: number;
  if (fourcc === 'VP8 ') {
    // Lossy: 3-byte frame tag, start code 9d 01 2a, then 14-bit LE size fields.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return null;
    }
    width = bytes.readUInt16LE(26) & 0x3fff;
    height = bytes.readUInt16LE(28) & 0x3fff;
  } else if (fourcc === 'VP8L') {
    // Lossless: signature byte 0x2f, then 14-bit width-1 and 14-bit height-1.
    if (bytes[20] !== 0x2f) {
      return null;
    }
    const bits = bytes.readUInt32LE(21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (fourcc === 'VP8X') {
    // Extended: 24-bit LE canvas width-1 and height-1.
    width =
      (bytes[24] as number) +
      ((bytes[25] as number) << 8) +
      ((bytes[26] as number) << 16) +
      1;
    height =
      (bytes[27] as number) +
      ((bytes[28] as number) << 8) +
      ((bytes[29] as number) << 16) +
      1;
  } else {
    return null;
  }
  return { contentType: 'image/webp', extension: 'webp', width, height };
}

/**
 * The image's real format and size, or null when the bytes are not a PNG, JPEG
 * or WebP (or their header is truncated or reports a zero size).
 */
export function inspectQaAttachmentImage(
  bytes: Buffer,
): QaAttachmentImageInfo | null {
  const info = readPng(bytes) ?? readJpeg(bytes) ?? readWebp(bytes);
  if (!info || info.width < 1 || info.height < 1) {
    return null;
  }
  return info;
}
