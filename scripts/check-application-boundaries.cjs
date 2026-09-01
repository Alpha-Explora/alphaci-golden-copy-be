#!/usr/bin/env node
'use strict';

/**
 * Keeps application code independent from infrastructure details.
 *
 * Own concrete repositories are permitted only when they live under the
 * module's infrastructure directory. Nested context folders may contain their
 * own infrastructure directory (for example projects/application/workflows),
 * so those files are not treated as application code.
 *
 * Usage:
 *   node ./scripts/check-application-boundaries.cjs
 *   node ./scripts/check-application-boundaries.cjs --json
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODULES_DIR = path.join(ROOT, 'src', 'modules');

function moduleNameOf(relPath) {
  const match = /^src\/modules\/([^/]+)\//.exec(relPath);
  return match ? match[1] : null;
}

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(full);
    }
  }
  return files;
}

function isOwnSchemaRepository(normalizedTarget) {
  const target = normalizedTarget.replace(/\.js$/, '');
  return /\/infrastructure\/[^/]*\.repository$/.test(target);
}

function resolveImportTarget(sourceRel, importPath) {
  if (importPath.startsWith('#modules/')) {
    return path.posix.normalize(
      `src/modules/${importPath.slice('#modules/'.length)}`,
    );
  }
  if (importPath.startsWith('.')) {
    return path.posix.normalize(
      path.posix.join(path.posix.dirname(sourceRel), importPath),
    );
  }
  return null;
}

function collectViolations() {
  const violations = [];

  for (const full of filesUnder(MODULES_DIR)) {
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    const sourceModule = moduleNameOf(rel);
    if (
      !sourceModule ||
      !rel.includes(`src/modules/${sourceModule}/application/`) ||
      rel.includes('/infrastructure/')
    ) {
      continue;
    }

    const content = fs.readFileSync(full, 'utf8');
    if (path.basename(rel).endsWith('.repository.ts')) {
      violations.push({
        kind: 'repository-in-application',
        module: sourceModule,
        file: rel,
        line: 1,
        target: null,
      });
    }

    const importRe = /(?:from|import\()\s*['"]([.#][^'"]+)['"]/g;
    let match;
    while ((match = importRe.exec(content)) !== null) {
      const normalized = resolveImportTarget(rel, match[1]);
      if (!normalized) continue;
      if (
        normalized.includes('/infrastructure/') &&
        !isOwnSchemaRepository(normalized)
      ) {
        const line = content.slice(0, match.index).split(/\r?\n/).length;
        violations.push({
          kind: 'infrastructure-import',
          module: sourceModule,
          file: rel,
          line,
          target: normalized,
        });
      }
    }
  }

  return violations.sort((a, b) =>
    `${a.file}:${a.line}:${a.target ?? ''}`.localeCompare(
      `${b.file}:${b.line}:${b.target ?? ''}`,
    ),
  );
}

const violations = collectViolations();

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(violations, null, 2));
  process.exit(violations.length > 0 ? 1 : 0);
}

if (violations.length > 0) {
  console.error(
    `Application boundary check failed: ${violations.length} violation(s).`,
  );
  for (const violation of violations) {
    const suffix = violation.target ? ` -> ${violation.target}` : '';
    console.error(`  ${violation.file}:${violation.line}${suffix}`);
  }
  console.error(
    'Keep application code free of infrastructure imports; place concrete repositories under infrastructure/ and expose external capabilities through focused ports.',
  );
  process.exit(1);
}

console.log('Application boundaries OK.');
