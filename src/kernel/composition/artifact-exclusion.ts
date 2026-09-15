import type { BuildProfile } from './build-profile.js';
import {
  artifactExclusionsFor,
  PACK_ARTIFACT_INVENTORY,
} from './build-profile.js';
import type { PackArtifactInventoryMap } from './build-profile.js';

export interface ArtifactEntry {
  readonly path: string;
  readonly content?: string;
}

export interface ArtifactExclusionFinding {
  readonly kind: 'source-root' | 'symbol';
  readonly value: string;
  readonly path: string;
}

export interface ArtifactExclusionScanInput {
  readonly profile: BuildProfile;
  readonly entries: readonly ArtifactEntry[];
  readonly inventory?: PackArtifactInventoryMap;
}

/**
 * Fail-closed scan for source-equivalent or compiled artifact entries.
 * Paths are normalized before comparison and symbols use whole-word matches,
 * so a marker cannot be hidden by platform separators or a larger identifier.
 */
export function scanArtifactExclusions({
  profile,
  entries,
  inventory,
}: ArtifactExclusionScanInput): readonly ArtifactExclusionFinding[] {
  const policy = artifactExclusionsFor(
    profile,
    inventory ?? PACK_ARTIFACT_INVENTORY,
  );
  const findings: ArtifactExclusionFinding[] = [];

  for (const entry of entries) {
    const normalizedPath = normalizePath(entry.path);
    for (const sourceRoot of policy.sourceRoots) {
      const normalizedRoot = normalizePath(sourceRoot).replace(/\/$/, '');
      if (
        normalizedPath === normalizedRoot ||
        normalizedPath.startsWith(`${normalizedRoot}/`)
      ) {
        findings.push({
          kind: 'source-root',
          value: sourceRoot,
          path: entry.path,
        });
      }
    }

    if (entry.content === undefined) continue;
    for (const symbol of policy.symbols) {
      const symbolPattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
      if (symbolPattern.test(entry.content)) {
        findings.push({ kind: 'symbol', value: symbol, path: entry.path });
      }
    }
  }

  return findings;
}

export function assertArtifactExclusionsAbsent(
  input: ArtifactExclusionScanInput,
): void {
  const findings = scanArtifactExclusions(input);
  if (findings.length === 0) return;

  const details = findings
    .map(({ kind, value, path }) => `${kind} '${value}' found in ${path}`)
    .join('; ');
  throw new Error(
    `artifact exclusion check failed for profile '${input.profile}': ${details}`,
  );
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
