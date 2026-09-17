import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertArtifactExclusionsAbsent } from './artifact-exclusion.js';
import type { ArtifactEntry } from './artifact-exclusion.js';

function withPlantedCompiledArtifact(
  relativePath: string,
  content: string,
  callback: (entry: ArtifactEntry) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), 'alphaci-artifact-exclusion-'));
  try {
    const artifactPath = join(directory, relativePath);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, content, 'utf8');
    callback({
      path: relativePath,
      content: readFileSync(artifactPath, 'utf8'),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('artifact exclusion scanner', () => {
  it('rejects a compiled file planted under a declared excluded root', () => {
    const inventory = {
      saas: { sourceRoots: ['src/packs/saas'], symbols: [] },
      edu: { sourceRoots: [], symbols: [] },
      enterprise: { sourceRoots: [], symbols: [] },
    } as const;

    withPlantedCompiledArtifact(
      'src/packs/saas/checkout.js',
      'export const checkout = true;',
      (entry) => {
        expect(() =>
          assertArtifactExclusionsAbsent({
            profile: 'enterprise',
            entries: [entry],
            inventory,
          }),
        ).toThrow(/source-root 'src\/packs\/saas'/);
      },
    );
  });

  it('rejects a compiled file containing a declared excluded symbol marker', () => {
    const inventory = {
      saas: { sourceRoots: [], symbols: [] },
      edu: { sourceRoots: [], symbols: ['EduOnlyWorkflow'] },
      enterprise: { sourceRoots: [], symbols: [] },
    } as const;

    withPlantedCompiledArtifact(
      'dist/workflows.js',
      'class EduOnlyWorkflow {}',
      (entry) => {
        expect(() =>
          assertArtifactExclusionsAbsent({
            profile: 'enterprise',
            entries: [entry],
            inventory,
          }),
        ).toThrow(/symbol 'EduOnlyWorkflow'/);
      },
    );
  });

  it('accepts a clean compiled artifact', () => {
    withPlantedCompiledArtifact(
      'dist/index.js',
      'const current = true;',
      (entry) => {
        expect(() =>
          assertArtifactExclusionsAbsent({
            profile: 'enterprise',
            entries: [entry],
          }),
        ).not.toThrow();
      },
    );
  });
});
