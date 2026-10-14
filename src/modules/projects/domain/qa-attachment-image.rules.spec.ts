import {
  jpegBytes,
  pngBytes,
  webpBytes,
} from '../__fixtures__/qa-attachment-images';
import { inspectQaAttachmentImage } from './qa-attachment-image.rules';

describe('inspectQaAttachmentImage', () => {
  it('reads a PNG from its IHDR', () => {
    expect(inspectQaAttachmentImage(pngBytes(1280, 720))).toEqual({
      contentType: 'image/png',
      extension: 'png',
      width: 1280,
      height: 720,
    });
  });

  it('reads a JPEG from its start-of-frame, skipping earlier segments', () => {
    expect(inspectQaAttachmentImage(jpegBytes(1920, 1080))).toEqual({
      contentType: 'image/jpeg',
      extension: 'jpg',
      width: 1920,
      height: 1080,
    });
  });

  it.each([
    ['lossy', 800, 600],
    ['lossless', 801, 601],
    ['extended', 4000, 3000],
  ] as const)('reads a %s WebP', (variant, width, height) => {
    expect(inspectQaAttachmentImage(webpBytes(variant, width, height))).toEqual(
      {
        contentType: 'image/webp',
        extension: 'webp',
        width,
        height,
      },
    );
  });

  it('rejects a PNG that is really text, whatever its name or declared type', () => {
    expect(
      inspectQaAttachmentImage(Buffer.from('this is not a png, just text')),
    ).toBeNull();
    expect(
      inspectQaAttachmentImage(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      ),
    ).toBeNull();
  });

  it('rejects a GIF and an empty buffer', () => {
    expect(
      inspectQaAttachmentImage(Buffer.from('GIF89a\x01\x00\x01\x00', 'binary')),
    ).toBeNull();
    expect(inspectQaAttachmentImage(Buffer.alloc(0))).toBeNull();
  });

  it('rejects truncated headers and zero sizes', () => {
    expect(
      inspectQaAttachmentImage(pngBytes(10, 10).subarray(0, 20)),
    ).toBeNull();
    expect(inspectQaAttachmentImage(pngBytes(0, 10))).toBeNull();
    expect(
      inspectQaAttachmentImage(jpegBytes(10, 10).subarray(0, 12)),
    ).toBeNull();
  });

  it('rejects a PNG signature with the wrong first chunk', () => {
    const bytes = pngBytes(10, 10);
    bytes.write('IDAT', 12, 'ascii');
    expect(inspectQaAttachmentImage(bytes)).toBeNull();
  });

  it('does not loop forever on a malformed JPEG segment length', () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00]);
    expect(inspectQaAttachmentImage(bytes)).toBeNull();
  });
});
