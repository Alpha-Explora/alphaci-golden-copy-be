import type { ConfigService } from '@nestjs/config';

import { EnvTokenEncryptionService } from './encryption.service';

const key = Buffer.alloc(32, 7).toString('base64');

const makeConfig = (encryptionKey = key) =>
  ({
    getOrThrow: jest.fn().mockReturnValue({
      envProvisioning: {
        encryptionKey,
      },
    }),
  }) as unknown as ConfigService;

describe('EnvTokenEncryptionService', () => {
  it('encrypts and decrypts provider tokens', () => {
    const service = new EnvTokenEncryptionService(makeConfig());
    const encrypted = service.encrypt('rnd_test_secret');

    expect(encrypted).not.toContain('rnd_test_secret');
    expect(service.decrypt(encrypted)).toBe('rnd_test_secret');
  });

  it('rejects malformed encryption keys', () => {
    expect(() => new EnvTokenEncryptionService(makeConfig('short'))).toThrow(
      /ENV_PROVISIONING_ENCRYPTION_KEY/,
    );
  });
});
