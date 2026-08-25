import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

import type { AppConfig } from '../../config/app.config';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const FORMAT_VERSION = 'v1';

@Injectable()
export class EnvTokenEncryptionService {
  private readonly key: Buffer;

  constructor(configService: ConfigService) {
    const config = configService.getOrThrow<AppConfig>('app');
    this.key = this.parseKey(config.envProvisioning.encryptionKey);
  }

  encrypt(plainText: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plainText, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [
      FORMAT_VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join(':');
  }

  decrypt(cipherText: string): string {
    const [version, iv, tag, encrypted] = cipherText.split(':');
    if (version !== FORMAT_VERSION || !iv || !tag || !encrypted) {
      throw new Error('Unsupported encrypted token format.');
    }

    const decipher = createDecipheriv(
      ALGORITHM,
      this.key,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  private parseKey(rawKey: string): Buffer {
    const key = Buffer.from(rawKey, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        'ENV_PROVISIONING_ENCRYPTION_KEY must be a base64-encoded 32-byte key.',
      );
    }

    return key;
  }
}
