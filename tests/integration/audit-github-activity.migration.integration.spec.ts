import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Client } from 'pg';

import type { DatabaseService } from '../../src/kernel/db/database.service';
import { AuditEventsRepository } from '../../src/modules/platform-ops/audit/infrastructure/audit-events.repository';

/**
 * Applies the whole migration tree to an EMPTY database up to
 * 20261002020000_audit_github_activity.sql, applies it, replays it, and runs
 * the GitHub ingest statements against real Postgres: dedupe on external_id,
 * actor-login resolution, the event's own created_at, scope, and the sync
 * state upsert. Then runs the rollback and re-applies the migration.
 *
 * Runs only when MIGRATION_TEST_DB_URL points at a throwaway, empty database.
 */
const dbUrl = process.env['MIGRATION_TEST_DB_URL'];
const describeDatabase = dbUrl ? describe : describe.skip;

const MIGRATION = '20261002020000_audit_github_activity.sql';
const ROLLBACK = '20261002020000_audit_github_activity_down.sql';
const migrationsRoot = resolve(__dirname, '../../supabase/migrations');
const rollbacksRoot = resolve(__dirname, '../../supabase/rollbacks');

function migrationFiles(dir: string, relative = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    const name = join(relative, entry.name);
    if (entry.isDirectory()) return migrationFiles(full, name);
    return entry.name.endsWith('.sql') ? [name] : [];
  });
}

const orderedFiles = migrationFiles(migrationsRoot).sort((a, b) =>
  basename(a).localeCompare(basename(b)),
);

async function applyFile(client: Client, file: string): Promise<void> {
  await client.query(readFileSync(join(migrationsRoot, file), 'utf8'));
}

async function count(client: Client, sql: string): Promise<number> {
  const result = await client.query<{ n: string }>(sql);
  return Number(result.rows[0]?.n ?? 0);
}

describeDatabase('audit_github_activity migration', () => {
  const client = new Client({ connectionString: dbUrl });
  const owner = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  let repository: AuditEventsRepository;

  const batch = (ids: string[]) => ({
    projectId,
    workspaceId,
    events: ids.map((id, index) => ({
      externalId: `github:${id}`,
      eventCode: 'github.push',
      message: `Pushed to dev (${id})`,
      metadata: { branch: 'dev', githubLogin: index === 0 ? 'Owner' : 'ghost' },
      actorLogin: index === 0 ? 'Owner' : 'ghost',
      occurredAt: `2026-09-0${String(index + 1)}T10:00:00.5Z`,
    })),
  });

  beforeAll(async () => {
    await client.connect();
    await client.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
       END $$;
       CREATE SCHEMA IF NOT EXISTS extensions;`,
    );
    for (const file of orderedFiles) {
      if (basename(file) >= MIGRATION) break;
      await applyFile(client, file);
    }
    await client.query(
      `INSERT INTO identity.app_users (id, login) VALUES ($1, 'owner');`,
      [owner],
    );
    await client.query(
      `INSERT INTO orgs.workspaces (id, owner_user_id, name, kind)
       VALUES ($1, $2, 'Team', 'team');`,
      [workspaceId, owner],
    );
    await client.query(
      `INSERT INTO projects.provisioned_projects
         (id, user_id, repo_full_name, template_id, service_name, workflow_path, workspace_id)
       VALUES ($1, $2, 'acme/a1', 'tpl', 'a1', '.github/workflows/ci.yml', $3);`,
      [projectId, owner, workspaceId],
    );
    // A row recorded by ALPHACI before the migration: it must keep working.
    await client.query(
      `INSERT INTO audit.audit_events (project_id, actor_user_id, event_code, message)
       VALUES ($1, $2, 'workflow_pr_created', 'Workflow update PR created');`,
      [projectId, owner],
    );
    repository = new AuditEventsRepository({
      query: (sql: string, params: unknown[]) => client.query(sql, params),
    } as unknown as DatabaseService);
  }, 120_000);

  afterAll(async () => {
    await client.end();
  });

  it('applies on a cold replay, twice, without touching existing rows', async () => {
    await applyFile(client, join('platform-ops', MIGRATION));
    await applyFile(client, join('platform-ops', MIGRATION));

    expect(
      await count(
        client,
        `SELECT COUNT(*) AS n FROM audit.audit_events WHERE external_id IS NULL`,
      ),
    ).toBe(1);
  });

  it('ingests GitHub events once, with their own time and the matching user', async () => {
    expect(await repository.insertExternalBatch(batch(['1', '2']))).toBe(2);
    // Re-sync: the same ids plus one new one -> only the new one is stored.
    expect(await repository.insertExternalBatch(batch(['1', '2', '3']))).toBe(
      1,
    );

    const rows = await repository.listForProject({
      projectId,
      deliveryProjectId: null,
      limit: 50,
      before: null,
    });
    const github = rows.filter((row) => row.scope === 'github');
    expect(github).toHaveLength(3);
    const first = github.find((row) => row.message.includes('(1)'));
    expect(first).toMatchObject({
      actorUserId: owner,
      actorLogin: 'owner',
      workspaceId,
      projectId,
      createdAt: '2026-09-01T10:00:00.500000Z',
    });
    expect(
      github.find((row) => row.message.includes('(2)'))?.actorUserId,
    ).toBeNull();
    // ALPHACI's own row keeps its scope.
    expect(rows.some((row) => row.scope === 'repository')).toBe(true);

    expect(
      await repository.findRecordedExternalIds([
        'github:1',
        'github:9',
        'github:3',
      ]),
    ).toEqual(new Set(['github:1', 'github:3']));
  });

  it('keeps one sync state per repository, case-insensitively', async () => {
    expect(await repository.findGithubSyncState('Acme/A1')).toBeNull();
    await repository.saveGithubSyncState('Acme/A1', {
      etag: 'W/"a"',
      syncedAt: '2026-10-02T10:00:00.000Z',
    });
    await repository.saveGithubSyncState('acme/a1', {
      etag: 'W/"b"',
      syncedAt: '2026-10-02T10:01:00.000Z',
    });
    expect(await repository.findGithubSyncState('ACME/a1')).toEqual({
      etag: 'W/"b"',
      syncedAt: '2026-10-02T10:01:00.000Z',
    });
    expect(
      await count(client, `SELECT COUNT(*) AS n FROM audit.github_event_syncs`),
    ).toBe(1);
  });

  it('rolls back cleanly and can be applied again', async () => {
    await client.query(readFileSync(join(rollbacksRoot, ROLLBACK), 'utf8'));
    expect(
      await count(
        client,
        `SELECT COUNT(*) AS n FROM information_schema.columns
          WHERE table_schema = 'audit' AND table_name = 'audit_events'
            AND column_name = 'external_id'`,
      ),
    ).toBe(0);
    expect(
      await count(client, `SELECT COUNT(*) AS n FROM audit.audit_events`),
    ).toBe(1);

    await applyFile(client, join('platform-ops', MIGRATION));
    expect(await repository.insertExternalBatch(batch(['1']))).toBe(1);
  });
});
