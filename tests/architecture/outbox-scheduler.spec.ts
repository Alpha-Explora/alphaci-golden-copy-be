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
  });

  it('keeps legacy unowned topics out of the active producer and relay surface', () => {
    const sourceFiles = [
      join(
        root,
        'src',
        'modules',
        'identity-access',
        'auth',
        'auth.service.ts',
      ),
      join(
        root,
        'src',
        'modules',
        'billing',
        'subscription',
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
});
