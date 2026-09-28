import { execFileSync } from 'node:child_process';

import {
  FIXTURE_COMPOSE_FILE,
  FIXTURE_COMPOSE_PROJECT,
  dropDatabase,
} from './database';

export default async function globalTeardown(): Promise<void> {
  const adminUrl = process.env['E2E_ADMIN_DATABASE_URL'];
  const name = process.env['E2E_APP_DATABASE_NAME'];
  if (adminUrl && name) await dropDatabase(adminUrl, name);

  if (process.env['E2E_STARTED_FIXTURE'] === 'true') {
    execFileSync(
      'docker',
      [
        'compose',
        '-f',
        FIXTURE_COMPOSE_FILE,
        '-p',
        FIXTURE_COMPOSE_PROJECT,
        'down',
        '-v',
      ],
      { stdio: 'inherit' },
    );
  }
}
