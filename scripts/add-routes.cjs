#!/usr/bin/env node
/**
 * Record new HTTP routes in the route inventory: add them to the baseline in
 * sorted order, recompute the baseline hash, and append an amendment naming
 * why they exist. tests/architecture/route-inventory.spec.ts checks the result
 * against the running application.
 *
 *   npm run routes:add -- --reason "Why these routes exist" "GET /api/v1/..." ...
 */
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const docs = join(__dirname, '..', 'docs', 'architecture');
const baselinePath = join(docs, 'route-inventory.baseline.txt');
const manifestPath = join(docs, 'route-inventory.manifest.json');

const args = process.argv.slice(2);
const reasonAt = args.indexOf('--reason');
const reason = reasonAt === -1 ? '' : (args[reasonAt + 1] ?? '').trim();
const routes = args.filter((_, index) => index !== reasonAt && index !== reasonAt + 1);

const ROUTE = /^(GET|POST|PUT|PATCH|DELETE) \/api\/v1\/\S+$/;
if (!reason || routes.length === 0 || !routes.every((route) => ROUTE.test(route))) {
  console.error('Usage: npm run routes:add -- --reason "<why>" "<METHOD> /api/v1/<path>" ...');
  process.exit(1);
}

const lines = readFileSync(baselinePath, 'utf8').split(/\r?\n/).filter(Boolean);
const added = routes.filter((route) => !lines.includes(route));
lines.push(...added);
lines.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
const baseline = lines.join('\n') + '\n';
writeFileSync(baselinePath, baseline);

const sha = createHash('sha256').update(baseline).digest('hex');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.routeCount = lines.length;
manifest.referenceSha256 = sha;
manifest.baselineSha256 = sha;
if (added.length > 0) manifest.amendments.push({ reason, routes: added });
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log('Route inventory: ' + String(added.length) + ' added, ' + String(lines.length) + ' total.');
