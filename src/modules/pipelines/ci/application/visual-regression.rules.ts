/**
 * Pure rules for the visual-regression ingestion boundary: what a snapshot
 * name, a browser label and an uploaded image must look like, and which
 * baselines a branch may use. No Nest, no I/O.
 */

/** Hard ceiling on one uploaded PNG. */
export const VISUAL_MAX_PNG_BYTES = 3 * 1024 * 1024;

/** Snapshots accepted per (run, browser). */
export const VISUAL_MAX_SNAPSHOTS_PER_RUN = 60;

export const VISUAL_NAME_MAX_LENGTH = 120;

/**
 * The browser a baseline is taken from. A run reported by several browsers is
 * shown (and approved) from chromium when it is present; see the migration for
 * why the baseline key does not include the browser.
 */
export const VISUAL_BASELINE_BROWSER = 'chromium';

/** The branch `main` inherits an approved baseline from when it has none of its own. */
export const VISUAL_INHERIT_FROM_BRANCH = 'uat';

/**
 * A safe file basename, the only name shape stored: no path separator, no
 * leading dot, only the characters a Playwright snapshot name is built from
 * (it sanitises everything else to '-'), at most 120 characters in total,
 * ending in lower-case `.png`.
 */
export const VISUAL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,115}\.png$/;

export function isSafeSnapshotName(name: unknown): name is string {
  return typeof name === 'string' && VISUAL_NAME_PATTERN.test(name);
}

/** Lower-case letters, digits, '_' and '-', at most 32 characters: "chromium", "webkit". */
export const VISUAL_BROWSER_PATTERN = /^[a-z0-9_-]{1,32}$/;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** True when the bytes start with the 8-byte PNG signature. */
export function hasPngSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= PNG_MAGIC.length &&
    PNG_MAGIC.every((byte, index) => bytes[index] === byte)
  );
}

/**
 * The branches whose baselines apply to `branch`, most specific first:
 * `main` falls back to `uat`'s approved set, every other branch is its own.
 */
export function baselineBranchesFor(branch: string): string[] {
  return branch === 'main' ? ['main', VISUAL_INHERIT_FROM_BRANCH] : [branch];
}
