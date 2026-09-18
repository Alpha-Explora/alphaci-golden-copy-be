import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { Injectable } from '@nestjs/common';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

@Injectable()
export class PasswordHasherService {
  async hash(secret: string): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    const derived = (await scryptAsync(secret, salt, KEY_LENGTH)) as Buffer;
    return `scrypt:${salt}:${derived.toString('hex')}`;
  }

  async verify(secret: string, storedHash: string): Promise<boolean> {
    const [scheme, salt, expectedHex] = storedHash.split(':');
    if (scheme !== 'scrypt' || !salt || !expectedHex) {
      return false;
    }

    const expected = Buffer.from(expectedHex, 'hex');
    if (expected.length === 0) {
      return false;
    }

    const actual = (await scryptAsync(secret, salt, expected.length)) as Buffer;
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
}
