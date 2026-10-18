import {
  deriveQaAttachmentLinkKey,
  isValidQaAttachmentLink,
  signQaAttachmentLink,
} from './qa-attachment-link';

const key = deriveQaAttachmentLinkKey('s'.repeat(32));
const PATH = 'run/item/att.png';
const NOW = 1_800_000_000;

describe('qa-attachment-link', () => {
  it('accepts a link signed for the same path and expiry', () => {
    const sig = signQaAttachmentLink(key, PATH, NOW + 60);

    expect(isValidQaAttachmentLink(key, PATH, NOW + 60, sig, NOW)).toBe(true);
  });

  it('accepts a link at the exact expiry second and rejects one second later', () => {
    const sig = signQaAttachmentLink(key, PATH, NOW);

    expect(isValidQaAttachmentLink(key, PATH, NOW, sig, NOW)).toBe(true);
    expect(isValidQaAttachmentLink(key, PATH, NOW, sig, NOW + 1)).toBe(false);
  });

  it('binds the signature to the path', () => {
    const sig = signQaAttachmentLink(key, PATH, NOW + 60);

    expect(isValidQaAttachmentLink(key, 'other.png', NOW + 60, sig, NOW)).toBe(
      false,
    );
  });

  it('binds the signature to the expiry', () => {
    const sig = signQaAttachmentLink(key, PATH, NOW + 60);

    expect(isValidQaAttachmentLink(key, PATH, NOW + 3600, sig, NOW)).toBe(
      false,
    );
  });

  it('rejects a signature minted under a different secret', () => {
    const other = deriveQaAttachmentLinkKey('t'.repeat(32));
    const sig = signQaAttachmentLink(other, PATH, NOW + 60);

    expect(isValidQaAttachmentLink(key, PATH, NOW + 60, sig, NOW)).toBe(false);
  });

  it('rejects malformed signatures before comparing', () => {
    expect(isValidQaAttachmentLink(key, PATH, NOW + 60, '', NOW)).toBe(false);
    expect(isValidQaAttachmentLink(key, PATH, NOW + 60, 'zz', NOW)).toBe(false);
    expect(
      isValidQaAttachmentLink(key, PATH, NOW + 60, 'A'.repeat(64), NOW),
    ).toBe(false);
  });

  it('rejects a non-integer expiry', () => {
    const sig = signQaAttachmentLink(key, PATH, NOW + 60.5);

    expect(isValidQaAttachmentLink(key, PATH, NOW + 60.5, sig, NOW)).toBe(
      false,
    );
  });

  it('derives a key that does not equal the raw secret (domain separated)', () => {
    expect(deriveQaAttachmentLinkKey('s'.repeat(32)).toString('hex')).not.toBe(
      's'.repeat(32),
    );
  });
});
