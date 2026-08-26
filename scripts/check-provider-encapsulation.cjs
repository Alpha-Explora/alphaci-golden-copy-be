#!/usr/bin/env node
'use strict';

/**
 * Diagnostic provider-identity gate. Provider implementations and provider
 * policy belong to runtime; this reports literal provider identifiers that
 * still leak into the other contexts before Task 5 removes them.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'src');
const RUNTIME_PREFIX = 'src/modules/runtime/';
const PROVIDER_LITERAL = /["'](render|vercel|gcp)["']/g;
const KNOWN_API_CONTRACT_DEBT = new Set([
  'src/modules/projects/application/workflows/dto/generate-workflow.dto.ts',
]);

function filesUnder(dir) {
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

function collectFindings() {
  const findings = [];
  for (const file of filesUnder(SOURCE_DIR)) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (rel.startsWith(RUNTIME_PREFIX)) continue;
    if (KNOWN_API_CONTRACT_DEBT.has(rel)) continue;
    const content = fs.readFileSync(file, 'utf8');
    let match;
    while ((match = PROVIDER_LITERAL.exec(content)) !== null) {
      findings.push({
        file: rel,
        line: content.slice(0, match.index).split(/\r?\n/).length,
        provider: match[1],
      });
    }
    PROVIDER_LITERAL.lastIndex = 0;
  }
  return findings;
}

const findings = collectFindings();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(findings, null, 2));
  process.exit(0);
}

if (findings.length === 0) {
  console.log('Provider encapsulation OK.');
  process.exit(0);
}

console.warn(
  `Provider encapsulation warning: ${findings.length} provider literal(s) outside runtime.`,
);
for (const finding of findings) {
  console.warn(`  ${finding.file}:${finding.line} -> ${finding.provider}`);
}
process.exit(1);
