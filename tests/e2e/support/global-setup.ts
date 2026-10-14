import { execFileSync } from 'node:child_process';

import {
  FIXTURE_ADMIN_URL,
  FIXTURE_COMPOSE_FILE,
  FIXTURE_COMPOSE_PROJECT,
  applySqlFiles,
  assertLoopbackDatabaseUrl,
  createDatabase,
  migrationFiles,
  uniqueDatabaseName,
} from './database';

/**
 * Start the disposable PostgreSQL fixture unless E2E_DATABASE_URL names one,
 * then create a fresh database with every migration applied. Test workers read
 * the resulting connection details from the environment.
 */
export default async function globalSetup(): Promise<void> {
  const explicitUrl = process.env['E2E_DATABASE_URL'];
  const adminUrl = explicitUrl ?? FIXTURE_ADMIN_URL;
  assertLoopbackDatabaseUrl(adminUrl);

  if (!explicitUrl) {
    execFileSync(
      'docker',
      [
        'compose',
        '-f',
        FIXTURE_COMPOSE_FILE,
        '-p',
        FIXTURE_COMPOSE_PROJECT,
        'up',
        '-d',
        '--wait',
      ],
      { stdio: 'inherit' },
    );
    process.env['E2E_STARTED_FIXTURE'] = 'true';
  }

  const name = uniqueDatabaseName('app');
  const url = await createDatabase(adminUrl, name);
  await applySqlFiles(url, migrationFiles());

  process.env['E2E_ADMIN_DATABASE_URL'] = adminUrl;
  process.env['E2E_APP_DATABASE_NAME'] = name;
  process.env['E2E_APP_DATABASE_URL'] = url;
}
