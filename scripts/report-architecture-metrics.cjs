#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODULES_DIR = path.join(ROOT, 'src', 'modules');

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

function moduleNameOf(relPath) {
  const match = /^src\/modules\/([^/]+)(?:\/|$)/.exec(relPath);
  return match ? match[1] : null;
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

function isRepositoryTarget(target) {
  return /\/infrastructure\/[^/]*\.repository(?:\.js)?$/.test(
    target.replace(/\.js$/, ''),
  );
}

function filesInLayer(sourceFiles, layer) {
  return sourceFiles.filter((file) =>
    path
      .relative(MODULES_DIR, file)
      .replace(/\\/g, '/')
      .split('/')
      .includes(layer),
  );
}

function collectModuleMetrics(moduleName) {
  const moduleRoot = path.join(MODULES_DIR, moduleName);
  const sourceFiles = filesUnder(moduleRoot);
  const applicationFiles = filesInLayer(sourceFiles, 'application').filter(
    (file) => !file.endsWith('.spec.ts'),
  );
  let infrastructureImports = 0;
  let forbiddenInfrastructureImports = 0;
  let crossModuleImports = 0;
  const crossContextPairs = new Set();
  let repositoryFilesInApplication = 0;

  // Layer metrics are intentionally application-focused, but boundary metrics
  // must inspect every production file. Cross-context imports commonly enter
  // through a public index alias (`#modules/...`) and the old relative-only
  // scan silently reported those as zero.
  const productionFiles = sourceFiles.filter(
    (file) => !file.endsWith('.spec.ts'),
  );
  for (const file of productionFiles) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const content = fs.readFileSync(file, 'utf8');
    const importRe = /(?:from|import\()\s*['"]([.][^'"]+)['"]/g;
    const aliasImportRe = /(?:from|import\()\s*['"](#modules\/[^'"]+)['"]/g;
    let match;
    for (const matcher of [importRe, aliasImportRe]) {
      while ((match = matcher.exec(content)) !== null) {
        const target = resolveImportTarget(rel, match[1]);
        if (!target) continue;
        const targetModule = moduleNameOf(target);
        const sourceModule = moduleNameOf(rel);
        if (targetModule && sourceModule && targetModule !== sourceModule) {
          crossModuleImports++;
          crossContextPairs.add(`${sourceModule}->${targetModule}`);
        }
      }
    }

    // Repository placement/import checks remain application-focused.
    if (applicationFiles.includes(file)) {
      if (
        path.basename(file).endsWith('.repository.ts') &&
        !rel.includes('/infrastructure/')
      ) {
        repositoryFilesInApplication++;
        forbiddenInfrastructureImports++;
      }
      const applicationImportRe = /(?:from|import\()\s*['"]([.][^'"]+)['"]/g;
      // Keep the existing relative infrastructure metric scoped to application
      // files; the separate dependency gate owns all cross-context edges.
      while ((match = applicationImportRe.exec(content)) !== null) {
        const target = resolveImportTarget(rel, match[1]);
        if (!target) continue;
        if (target.includes('/infrastructure/')) {
          infrastructureImports++;
          if (!isRepositoryTarget(target)) forbiddenInfrastructureImports++;
        }
      }
    }
  }

  return {
    module: moduleName,
    sourceFiles: sourceFiles.length,
    domainFiles: filesInLayer(sourceFiles, 'domain').filter(
      (file) => !file.endsWith('.spec.ts'),
    ).length,
    applicationFiles: applicationFiles.length,
    portFiles: filesInLayer(sourceFiles, 'ports').filter(
      (file) => !file.endsWith('.spec.ts'),
    ).length,
    infrastructureImports,
    forbiddenInfrastructureImports,
    repositoryFilesInApplication,
    crossModuleImports,
    crossContextPairs: [...crossContextPairs].sort(),
    crossContextPairCount: crossContextPairs.size,
    deadInProcessAdapters: sourceFiles.filter((file) =>
      path.basename(file).startsWith('in-process-'),
    ).length,
    testFiles: sourceFiles.filter((file) => file.endsWith('.spec.ts')).length,
    hasPublicApi: fs.existsSync(path.join(moduleRoot, 'index.ts')),
  };
}

const modules = fs
  .readdirSync(MODULES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .map(collectModuleMetrics);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(modules, null, 2));
  process.exit(0);
}

const columns = [
  ['module', 'module'],
  ['domain', 'domainFiles'],
  ['application', 'applicationFiles'],
  ['ports', 'portFiles'],
  ['infra imports', 'infrastructureImports'],
  ['forbidden', 'forbiddenInfrastructureImports'],
  ['cross-module', 'crossModuleImports'],
  ['cross-context pairs', 'crossContextPairCount'],
  ['dead adapters', 'deadInProcessAdapters'],
  ['tests', 'testFiles'],
];
const widths = columns.map(([label, key]) =>
  Math.max(label.length, ...modules.map((item) => String(item[key]).length)),
);
const formatRow = (values) =>
  values.map((value, index) => String(value).padEnd(widths[index])).join('  ');

console.log(formatRow(columns.map(([label]) => label)));
console.log(formatRow(columns.map(([, key], index) => '-'.repeat(widths[index]))));
for (const item of modules) {
  console.log(formatRow(columns.map(([, key]) => item[key])));
}

const total = modules.reduce(
  (sum, item) => {
    for (const [, key] of columns.slice(1)) sum[key] += item[key];
    return sum;
  },
  Object.fromEntries(columns.slice(1).map(([, key]) => [key, 0])),
);
console.log('');
console.log(`Totals: ${JSON.stringify(total)}`);
