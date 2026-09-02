import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');

describe('outbox scheduler wiring', () => {
  it('deploys exactly one scheduled owner for platform.outbox_events', () => {
    const renderBlueprint = readFileSync(join(root, 'render.yaml'), 'utf8');
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const runner = readFileSync(
      join(root, 'scripts', 'process-outbox.cjs'),
      'utf8',
    );

    expect(renderBlueprint).toContain('type: cron');
    expect(renderBlueprint).toContain('name: alphaci-outbox-relay');
    expect(renderBlueprint).toContain('schedule: "*/1 * * * *"');
    expect(renderBlueprint).toContain('key: OUTBOX_MAX_ATTEMPTS');
    expect(renderBlueprint).toContain('key: OUTBOX_RETRY_DELAY_SECONDS');
    expect(renderBlueprint).toContain('key: SUPABASE_DB_CA_CERT');
    expect(
      renderBlueprint.match(
        /dockerCommand:\s+node scripts\/process-outbox\.cjs/g,
      ),
    ).toHaveLength(1);
    expect(dockerfile).toContain(
      'scripts/process-outbox.cjs ./scripts/process-outbox.cjs',
    );
    expect(dockerfile).toContain('CMD ["node", "dist/src/main.js"]');
    expect(dockerfile).not.toContain('CMD ["node", "dist/main"]');
    expect(runner).toContain('OutboxRelayService');
    expect(runner).toContain('processPendingOnce');
    expect(runner).toContain('positiveInteger');
    expect(runner).toContain('OUTBOX_BATCH_SIZE');
    expect(runner).toContain('Math.min');
  });

  it('keeps legacy unowned topics out of the active producer and relay surface', () => {
    const sourceFiles = [
      join(
        root,
        'src',
        'modules',
        'identity-access',
        'auth',
        'application',
        'auth.service.ts',
      ),
      join(
        root,
        'src',
        'modules',
        'billing',
        'subscription',
        'application',
        'subscription.service.ts',
      ),
      join(
        root,
        'src',
        'modules',
        'projects',
        'application',
        'workflows',
        'workflows.service.ts',
      ),
      join(root, 'src', 'kernel', 'events', 'outbox.repository.ts'),
    ];
    const source = sourceFiles
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');

    for (const topic of [
      'user.signed_in',
      'subscription.activated',
      'subscription.canceled',
      'workflow.generated',
    ]) {
      expect(source).not.toContain(topic);
    }

    const quarantine = readFileSync(
      join(
        root,
        'supabase',
        'migrations',
        'platform-ops',
        '20260827000000_quarantine_unowned_outbox_topics.sql',
      ),
      'utf8',
    );
    expect(quarantine).toContain("SET status = 'ignored'");
    expect(quarantine).toContain('topic IN (');
  });

  it('defines durable relay leases and requires explicit hierarchy mode', () => {
    const renderBlueprint = readFileSync(join(root, 'render.yaml'), 'utf8');
    const reliabilityMigration = readFileSync(
      join(
        root,
        'supabase',
        'migrations',
        'platform-ops',
        '20260828000000_outbox_reliability.sql',
      ),
      'utf8',
    );
    const runner = readFileSync(
      join(root, 'scripts', 'process-outbox.cjs'),
      'utf8',
    );
    const reliabilityRollback = readFileSync(
      join(
        root,
        'supabase',
        'rollbacks',
        '20260828000000_outbox_reliability_down.sql',
      ),
      'utf8',
    );
    const quarantineRollback = readFileSync(
      join(
        root,
        'supabase',
        'rollbacks',
        '20260827000000_quarantine_unowned_outbox_topics_down.sql',
      ),
      'utf8',
    );

    expect(reliabilityMigration).toContain('lease_token TEXT');
    expect(reliabilityMigration).toContain('lease_expires_at TIMESTAMPTZ');
    expect(renderBlueprint).toContain('key: HIERARCHY_GITHUB_SYNC_MODE');
    expect(renderBlueprint).toContain('key: OUTBOX_LEASE_SECONDS');
    expect(renderBlueprint).toContain('key: OUTBOX_HANDLER_TIMEOUT_MS');
    expect(runner).toContain('HIERARCHY_GITHUB_SYNC_MODE');
    expect(runner).toContain('explicitly');
    expect(reliabilityRollback).toContain('Rollback refused');
    expect(reliabilityRollback).toContain('lease_token = NULL');
    expect(reliabilityRollback).not.toContain('LOSSY');
    expect(quarantineRollback).toContain("SET status = 'pending'");
  });

  it('fails closed before a reliability rollback can discard quarantine diagnostics', () => {
    const rollback = readFileSync(
      join(
        root,
        'supabase',
        'rollbacks',
        '20260828000000_outbox_reliability_down.sql',
      ),
      'utf8',
    );
    const preflight = rollback.indexOf('RAISE EXCEPTION');
    const quarantineGuard = rollback.indexOf("status = 'quarantined'");
    const columnDrop = rollback.indexOf('DROP COLUMN');

    expect(preflight).toBeGreaterThan(-1);
    expect(quarantineGuard).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(columnDrop);
    expect(rollback).toContain('quarantined_at');
    expect(rollback).toContain('last_error');
  });
});
