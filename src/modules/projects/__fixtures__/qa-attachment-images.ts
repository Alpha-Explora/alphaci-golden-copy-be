/** Minimal byte fixtures: only the headers inspectQaAttachmentImage reads. */
export function pngBytes(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

export function jpegBytes(width: number, height: number): Buffer {
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.alloc(14),
  ]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

export function webpBytes(
  variant: 'lossy' | 'lossless' | 'extended',
  width: number,
  height: number,
): Buffer {
  const bytes = Buffer.alloc(40);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(32, 4);
  bytes.write('WEBP', 8, 'ascii');
  if (variant === 'lossy') {
    bytes.write('VP8 ', 12, 'ascii');
    bytes[23] = 0x9d;
    bytes[24] = 0x01;
    bytes[25] = 0x2a;
    bytes.writeUInt16LE(width, 26);
    bytes.writeUInt16LE(height, 28);
  } else if (variant === 'lossless') {
    bytes.write('VP8L', 12, 'ascii');
    bytes[20] = 0x2f;
    bytes.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  } else {
    bytes.write('VP8X', 12, 'ascii');
    const w = width - 1;
    const h = height - 1;
    bytes[24] = w & 0xff;
    bytes[25] = (w >> 8) & 0xff;
    bytes[26] = (w >> 16) & 0xff;
    bytes[27] = h & 0xff;
    bytes[28] = (h >> 8) & 0xff;
    bytes[29] = (h >> 16) & 0xff;
  }
  return bytes;
}
