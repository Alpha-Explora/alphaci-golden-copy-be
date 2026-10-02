import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Client } from 'pg';

import type { DatabaseService } from '../../src/kernel/db/database.service';
import { AuditEventsRepository } from '../../src/modules/platform-ops/audit/infrastructure/audit-events.repository';

/**
 * Applies the whole migration tree to an EMPTY database, seeds the outbox the
 * way production looked (audit events published while recording was off), then
 * applies 20261002010000_backfill_dropped_audit_events.sql and replays it.
 * Real Postgres, no mocks: this catches invalid DDL that IF NOT EXISTS would
 * otherwise hide, and the FK behaviour for deleted projects.
 *
 * Runs only when MIGRATION_TEST_DB_URL points at a throwaway, empty database.
 */
const dbUrl = process.env['MIGRATION_TEST_DB_URL'];
const describeDatabase = dbUrl ? describe : describe.skip;

const MIGRATION = '20261002010000_backfill_dropped_audit_events.sql';
const FIRST_QA_MIGRATION = '20260925010000_qa_checklists.sql';
const AUDIT_TOPIC = 'platform.audit.recorded';
const migrationsRoot = resolve(__dirname, '../../supabase/migrations');

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

interface BackfilledRow {
  outbox_event_id: string;
  event_code: string;
  project_id: string | null;
  workspace_id: string | null;
  actor_user_id: string | null;
  created_at: string;
  metadata_json: Record<string, unknown>;
}

describeDatabase('backfill_dropped_audit_events migration', () => {
  const client = new Client({ connectionString: dbUrl });
  const owner = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const deletedProjectId = randomUUID();
  const deliveryProjectId = randomUUID();

  const outbox = {
    repoEvent: randomUUID(),
    deletedRepoEvent: randomUUID(),
    projectEvent: randomUUID(),
    malformedIdEvent: randomUUID(),
    pending: randomUUID(),
    otherTopic: randomUUID(),
    noMessage: randomUUID(),
    alreadyRecordedLive: randomUUID(),
  };
  const repoEventAt = '2026-09-08T10:00:00.123456Z';

  async function seedOutbox(
    id: string,
    options: {
      topic?: string;
      status?: string;
      createdAt: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO platform.outbox_events
         (id, topic, aggregate_type, aggregate_id, payload, status, created_at)
       VALUES ($1, $2, 'project', 'x', $3::jsonb, $4, $5::timestamptz);`,
      [
        id,
        options.topic ?? AUDIT_TOPIC,
        JSON.stringify(options.payload),
        options.status ?? 'published',
        options.createdAt,
      ],
    );
  }

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

    // Everything before the migration under test: the shape production had.
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

    await seedOutbox(outbox.repoEvent, {
      createdAt: repoEventAt,
      payload: {
        eventCode: 'workflow_pr_created',
        message: 'Workflow update PR created',
        projectId,
        workspaceId,
        actorUserId: owner,
        metadata: { pullRequestNumber: 7 },
      },
    });
    // A deleted repository: its FK target is gone, the event must survive.
    await seedOutbox(outbox.deletedRepoEvent, {
      createdAt: '2026-09-09T10:00:00Z',
      payload: {
        eventCode: 'project_github_repo_deleted',
        message: 'Repository deleted',
        projectId: deletedProjectId,
        workspaceId,
        actorUserId: owner,
      },
    });
    // Project-level (requirement) event: no repository.
    await seedOutbox(outbox.projectEvent, {
      createdAt: '2026-09-10T10:00:00Z',
      payload: {
        eventCode: 'qa.requirement.created',
        message: 'QA requirement "Login" created',
        workspaceId,
        actorUserId: owner,
        metadata: { deliveryProjectId, requirementId: randomUUID() },
      },
    });
    await seedOutbox(outbox.malformedIdEvent, {
      createdAt: '2026-09-11T10:00:00Z',
      payload: {
        eventCode: 'odd',
        message: 'Odd ids',
        projectId: 'not-a-uuid',
        actorUserId: 'also-not-a-uuid',
        metadata: 'not an object',
      },
    });
    // Not backfilled: pending, other topic, unusable payload.
    await seedOutbox(outbox.pending, {
      status: 'pending',
      createdAt: '2026-09-12T10:00:00Z',
      payload: { eventCode: 'pending', message: 'Still queued' },
    });
    await seedOutbox(outbox.otherTopic, {
      topic: 'platform.notification.requested',
      createdAt: '2026-09-12T10:00:00Z',
      payload: { eventCode: 'other', message: 'Not an audit event' },
    });
    await seedOutbox(outbox.noMessage, {
      createdAt: '2026-09-12T10:00:00Z',
      payload: { eventCode: 'broken' },
    });
    // Recorded live after recording was switched on, and still in the outbox.
    await seedOutbox(outbox.alreadyRecordedLive, {
      createdAt: '2026-09-20T10:00:00Z',
      payload: {
        eventCode: 'drift_detected',
        message: 'Drift detected',
        projectId,
        actorUserId: owner,
      },
    });
    await client.query(
      `INSERT INTO audit.audit_events
         (project_id, actor_user_id, event_code, message, created_at)
       VALUES ($1, $2, 'drift_detected', 'Drift detected', '2026-09-20T10:00:03Z');`,
      [projectId, owner],
    );
  }, 120_000);

  afterAll(async () => {
    await client.end();
  });

  async function backfilled(): Promise<BackfilledRow[]> {
    const result = await client.query<BackfilledRow>(
      `SELECT outbox_event_id, event_code, project_id, workspace_id, actor_user_id,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
              metadata_json
         FROM audit.audit_events
        WHERE outbox_event_id IS NOT NULL
        ORDER BY created_at;`,
    );
    return result.rows;
  }

  it('copies the dropped outbox payloads, keeping the outbox time', async () => {
    await applyFile(client, join('platform-ops', MIGRATION));

    const rows = await backfilled();
    expect(rows.map((row) => row.outbox_event_id)).toEqual([
      outbox.repoEvent,
      outbox.deletedRepoEvent,
      outbox.projectEvent,
      outbox.malformedIdEvent,
    ]);

    const [repo, deleted, project, malformed] = rows;
    expect(repo).toMatchObject({
      event_code: 'workflow_pr_created',
      project_id: projectId,
      workspace_id: workspaceId,
      actor_user_id: owner,
      created_at: '2026-09-08T10:00:00.123456Z',
    });
    expect(repo?.metadata_json).toMatchObject({
      pullRequestNumber: 7,
      backfilledFromOutbox: true,
    });

    // The FK target is gone: the row is kept with the id parked in metadata.
    expect(deleted).toMatchObject({
      event_code: 'project_github_repo_deleted',
      project_id: null,
      workspace_id: workspaceId,
    });
    expect(deleted?.metadata_json).toMatchObject({
      originalProjectId: deletedProjectId,
    });

    // A Project-level event stays project-less and keeps deliveryProjectId.
    expect(project).toMatchObject({
      event_code: 'qa.requirement.created',
      project_id: null,
    });
    expect(project?.metadata_json).toMatchObject({ deliveryProjectId });

    // Unparseable ids and metadata degrade to NULL / {} instead of failing.
    expect(malformed).toMatchObject({
      project_id: null,
      actor_user_id: null,
    });
  });

  it('skips pending rows, other topics, unusable payloads and events already recorded live', async () => {
    expect(
      await count(
        client,
        `SELECT COUNT(*) AS n FROM audit.audit_events WHERE event_code IN ('pending', 'other', 'broken')`,
      ),
    ).toBe(0);
    // Only the live row exists for the drift event.
    expect(
      await count(
        client,
        `SELECT COUNT(*) AS n FROM audit.audit_events WHERE event_code = 'drift_detected'`,
      ),
    ).toBe(1);
  });

  it('is idempotent: re-running the migration and the QA-era tree inserts nothing', async () => {
    const total = await count(
      client,
      `SELECT COUNT(*) AS n FROM audit.audit_events;`,
    );

    await applyFile(client, join('platform-ops', MIGRATION));
    for (const file of orderedFiles.filter(
      (f) => basename(f) >= FIRST_QA_MIGRATION,
    )) {
      await applyFile(client, file);
    }

    expect(
      await count(client, `SELECT COUNT(*) AS n FROM audit.audit_events;`),
    ).toBe(total);
    expect(await backfilled()).toHaveLength(4);
  });

  it('enforces one backfilled row per outbox event', async () => {
    await expect(
      client.query(
        `INSERT INTO audit.audit_events (event_code, message, outbox_event_id)
         VALUES ('dup', 'dup', '${outbox.repoEvent}');`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('lists a repository and its Project events, never another Project, and pages by createdAt', async () => {
    const repository = new AuditEventsRepository({
      query: (sql: string, params: unknown[]) => client.query(sql, params),
    } as unknown as DatabaseService);

    const all = await repository.listForProject({
      projectId,
      deliveryProjectId,
      limit: 50,
      before: null,
    });
    // Repository events: the backfilled PR event and the live drift event.
    // Project event: the requirement. The deleted-repo row is project-less and
    // has no deliveryProjectId, so it belongs to neither.
    expect(all.map((row) => [row.eventCode, row.scope])).toEqual([
      ['drift_detected', 'repository'],
      ['qa.requirement.created', 'project'],
      ['workflow_pr_created', 'repository'],
    ]);
    expect(
      all.every(
        (row) => row.actorLogin === 'owner' || row.actorUserId === null,
      ),
    ).toBe(true);
    expect(all.at(-1)?.createdAt).toBe('2026-09-08T10:00:00.123456Z');

    // Another Project's repository sees only its own events.
    expect(
      await repository.listForProject({
        projectId: randomUUID(),
        deliveryProjectId: randomUUID(),
        limit: 50,
        before: null,
      }),
    ).toEqual([]);

    // Cursor: strictly older than the project event.
    const older = await repository.listForProject({
      projectId,
      deliveryProjectId,
      limit: 50,
      before: all[1]!.createdAt,
    });
    expect(older.map((row) => row.eventCode)).toEqual(['workflow_pr_created']);

    // Without the Project, only repository-scope events are returned.
    const repoOnly = await repository.listForProject({
      projectId,
      deliveryProjectId: null,
      limit: 50,
      before: null,
    });
    expect(repoOnly.every((row) => row.scope === 'repository')).toBe(true);
  });
});
