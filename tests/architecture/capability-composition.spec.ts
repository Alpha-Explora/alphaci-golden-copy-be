import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { CAPABILITIES } from '../../src/kernel/composition/capability-registry.js';
import { PACK_MANIFESTS } from '../../src/kernel/composition/manifests.js';

const repositoryRoot = resolve(__dirname, '../..');
const compositionRoot = resolve(repositoryRoot, 'src/kernel/composition');

describe('capability composition architecture', () => {
  it('keeps composition source in the kernel without importing bounded contexts', () => {
    for (const file of [
      'capability-types.ts',
      'capability-registry.ts',
      'manifests.ts',
      'capability-resolver.port.ts',
      'index.ts',
    ]) {
      expect(readFileSync(resolve(compositionRoot, file), 'utf8')).not.toMatch(
        /src\/modules/,
      );
    }
  });

  it('keeps the catalog application-owned after the documentation source is retired', () => {
    expect(
      existsSync(resolve(repositoryRoot, 'docs/capabilities/registry.ts')),
    ).toBe(false);
    expect(CAPABILITIES).toHaveLength(29);
    expect(Object.keys(PACK_MANIFESTS)).toEqual(['saas', 'edu', 'enterprise']);
  });

  it('selects editions through data maps rather than source comparison branches', () => {
    const sources = [
      resolve(repositoryRoot, 'src/kernel/config/app.config.ts'),
      ...[
        'capability-manifest-source.port.ts',
        'static-capability-manifest-source.ts',
        'capability-resolver.service.ts',
        'composition.module.ts',
      ].map((file) => resolve(compositionRoot, file)),
    ];

    for (const file of sources) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/edition\s*!==?\s*/);
      expect(readFileSync(file, 'utf8')).not.toMatch(/edition\s*===?\s*/);
    }
  });

  it('keeps request scope at the HTTP boundary', () => {
    const applicationServices = [
      'src/modules/billing/usage/application/usage-quota.service.ts',
      'src/modules/platform-ops/audit/application/audit-events.service.ts',
      'src/modules/platform-ops/notifications/application/notification-events.service.ts',
      'src/modules/projects/application/ci-runs/project-ci-runs.service.ts',
      'src/modules/projects/application/dashboard/project-dashboard.service.ts',
      'src/modules/projects/application/dashboard/project-previews.query-service.ts',
      'src/modules/projects/application/drift/project-drift-repair.handler.ts',
      'src/modules/projects/application/lifecycle/projects.service.ts',
      'src/modules/projects/application/workflows/project-workflows.service.ts',
      'src/modules/runtime/application/deployment-targets.service.ts',
      'src/modules/runtime/application/project-deployments.service.ts',
      'src/modules/runtime/application/project-drift.service.ts',
    ];

    for (const file of applicationServices) {
      const source = readFileSync(resolve(repositoryRoot, file), 'utf8');
      expect(source).not.toMatch(/@Inject\(CAPABILITY_RESOLVER\)/);
      expect(source).toMatch(/@Inject\(DEPLOYMENT_CAPABILITY_RESOLVER\)/);
    }
  });
});
