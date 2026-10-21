import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { FILE_ENV_ALLOW_LIST } from '../../../src/kernel/config/file-env';

interface ComposeService {
  environment?: Record<string, string>;
  secrets?: string[];
}

const compose = load(
  readFileSync(resolve('deploy/selfhost/compose.yaml'), 'utf8'),
) as { services: { migrate: ComposeService } };
const migrate = compose.services.migrate;

// migrate shares alphaci.env with the api but mounts only the database URL.
// The runner resolves every allow-listed X_FILE and fails closed on a file it
// cannot read, so a secret setting alphaci.env gains (alphaci-ctl sonar wrote
// ALPHACI_SONAR_TOKEN_FILE) stopped migrate, and with it every api start.
describe('self-hosted compose: migrate', () => {
  const databaseUrls = ['DATABASE_URL', 'SUPABASE_DB_URL'];

  it.each(FILE_ENV_ALLOW_LIST.filter((key) => !databaseUrls.includes(key)))(
    'blanks %s_FILE, which it has no secret mounted for',
    (key) => {
      expect(migrate.environment?.[`${key}_FILE`]).toBe('');
    },
  );

  it('mounts only the database URL', () => {
    expect(migrate.secrets).toEqual(['database_url']);
  });
});
