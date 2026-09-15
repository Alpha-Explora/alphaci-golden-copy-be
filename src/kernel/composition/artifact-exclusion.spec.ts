import {
  assertArtifactExclusionsAbsent,
  scanArtifactExclusions,
} from './artifact-exclusion.js';

describe('artifact exclusion scanner', () => {
  it('accepts the current empty exclusion inventory', () => {
    expect(
      scanArtifactExclusions({
        profile: 'enterprise',
        entries: [
          {
            path: 'src/modules/projects/project.service.ts',
            content: 'export class ProjectService {}',
          },
        ],
      }),
    ).toEqual([]);
    expect(() =>
      assertArtifactExclusionsAbsent({
        profile: 'enterprise',
        entries: [{ path: 'dist/index.js', content: 'const current = true;' }],
      }),
    ).not.toThrow();
  });

  it('fails closed for a declared excluded source root', () => {
    const inventory = {
      saas: { sourceRoots: ['src/packs/saas'], symbols: [] },
      edu: { sourceRoots: [], symbols: [] },
      enterprise: { sourceRoots: [], symbols: [] },
    } as const;

    expect(
      scanArtifactExclusions({
        profile: 'enterprise',
        entries: [{ path: 'src/packs/saas/checkout.ts' }],
        inventory,
      }),
    ).toEqual([
      {
        kind: 'source-root',
        value: 'src/packs/saas',
        path: 'src/packs/saas/checkout.ts',
      },
    ]);
  });

  it('fails closed for a declared excluded symbol marker', () => {
    const inventory = {
      saas: { sourceRoots: [], symbols: [] },
      edu: { sourceRoots: [], symbols: ['EduOnlyWorkflow'] },
      enterprise: { sourceRoots: [], symbols: [] },
    } as const;

    expect(() =>
      assertArtifactExclusionsAbsent({
        profile: 'enterprise',
        entries: [
          { path: 'dist/workflows.js', content: 'class EduOnlyWorkflow {}' },
        ],
        inventory,
      }),
    ).toThrow(/EduOnlyWorkflow/);
  });
});
