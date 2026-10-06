import { browserTestDevDependencies } from '../workflows/browser-test-dependencies';

/** Just the package.json fields these helpers read. */
interface PackageJsonShape {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function parse(raw: string): PackageJsonShape | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as PackageJsonShape)
      : null;
  } catch {
    return null;
  }
}

/**
 * Whether the repository renders in a browser, judged from its package.json.
 * Next.js and React are the two frontends the scaffold produces, so those are
 * the two recognised; a repository with neither has nothing for the pack to
 * visit and is refused rather than handed tests that cannot pass.
 */
export function isFrontendPackage(raw: string | null): boolean {
  const pkg = raw === null ? null : parse(raw);
  if (!pkg) return false;
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return 'next' in all || 'react' in all;
}

/** The `@playwright/test` range the repository declares, or null. */
export function readPlaywrightVersion(raw: string | null): string | null {
  const pkg = raw === null ? null : parse(raw);
  if (!pkg) return null;
  return (
    pkg.devDependencies?.['@playwright/test'] ??
    pkg.dependencies?.['@playwright/test'] ??
    null
  );
}

/** The first x.y.z in a semver range ('^1.49.0' -> [1, 49, 0]), or null. */
function floorOf(range: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True only when `existing` is provably older than `wanted`. */
function isOlder(existing: string, wanted: string): boolean {
  const have = floorOf(existing);
  const want = floorOf(wanted);
  // 'latest', '*', a git URL: not provably older, so never touched.
  if (!have || !want) return false;
  for (let i = 0; i < 3; i += 1) {
    const a = have[i] as number;
    const b = want[i] as number;
    if (a !== b) return a < b;
  }
  return false;
}

export interface PackageJsonUpdate {
  /** The new file text. Equal to the input when nothing needed to change. */
  content: string;
  changed: boolean;
}

/**
 * Add the browser-test devDependencies and the `test:e2e` script to a
 * package.json that has NO lockfile.
 *
 * Never a downgrade: a dependency the repository already pins at the same or a
 * newer version, or in a form that cannot be compared, is left exactly as is.
 * A dependency that is older than what the pack needs is raised, because the
 * visual checks need @playwright/test >= 1.50 and an older one fails.
 * Returns null when the text is not a JSON object, so the caller can leave the
 * file alone and say so instead of writing something broken.
 *
 * Formatting is preserved as far as JSON allows: the existing indent and
 * trailing newline are kept.
 */
export function updatePackageJson(raw: string): PackageJsonUpdate | null {
  const pkg = parse(raw);
  if (!pkg) return null;

  let changed = false;
  const devDependencies = { ...pkg.devDependencies };
  for (const [name, wanted] of Object.entries(browserTestDevDependencies())) {
    const existing = devDependencies[name] ?? pkg.dependencies?.[name];
    if (existing === undefined) {
      devDependencies[name] = wanted;
      changed = true;
    } else if (name in devDependencies && isOlder(existing, wanted)) {
      devDependencies[name] = wanted;
      changed = true;
    }
  }

  const scripts = { ...pkg.scripts };
  if (scripts['test:e2e'] === undefined) {
    scripts['test:e2e'] = 'playwright test';
    changed = true;
  }

  if (!changed) {
    return { content: raw, changed: false };
  }

  // npm keeps dependency maps sorted; follow it so the diff is only our lines.
  const sorted = Object.fromEntries(
    Object.entries(devDependencies).sort(([a], [b]) => a.localeCompare(b)),
  );
  const next = { ...pkg, scripts, devDependencies: sorted };

  const indent = /^[ \t]+(?=")/m.exec(raw)?.[0] ?? '  ';
  const trailingNewline = raw.endsWith('\n') ? '\n' : '';
  return {
    content: JSON.stringify(next, null, indent) + trailingNewline,
    changed: true,
  };
}
