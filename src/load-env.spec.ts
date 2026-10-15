import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnvFiles } from './load-env';

describe('loadEnvFiles', () => {
  const keys = ['LOAD_ENV_SPEC_A', 'LOAD_ENV_SPEC_B', 'LOAD_ENV_SPEC_C'];
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'load-env-'));
    for (const key of keys) delete process.env[key];
  });
  afterAll(() => {
    for (const key of keys) delete process.env[key];
  });

  it('loads files in order like ConfigModule: earlier files and the environment win', () => {
    const local = join(dir, '.env.local');
    const base = join(dir, '.env');
    writeFileSync(local, 'LOAD_ENV_SPEC_A=local\n');
    writeFileSync(
      base,
      "LOAD_ENV_SPEC_A=base\nLOAD_ENV_SPEC_B='https://api.example.com'\nLOAD_ENV_SPEC_C=file\n",
    );
    process.env['LOAD_ENV_SPEC_C'] = 'preset';

    loadEnvFiles([local, base, join(dir, 'missing.env')]);

    expect(process.env['LOAD_ENV_SPEC_A']).toBe('local');
    expect(process.env['LOAD_ENV_SPEC_B']).toBe('https://api.example.com');
    expect(process.env['LOAD_ENV_SPEC_C']).toBe('preset');
  });

  it('loads nothing when the E2E suite asks to ignore env files', () => {
    const base = join(dir, '.env');
    writeFileSync(base, 'LOAD_ENV_SPEC_A=base\n');

    process.env['ALPHACI_IGNORE_ENV_FILE'] = 'true';
    loadEnvFiles([base]);
    delete process.env['ALPHACI_IGNORE_ENV_FILE'];

    expect(process.env['LOAD_ENV_SPEC_A']).toBeUndefined();
  });
});
