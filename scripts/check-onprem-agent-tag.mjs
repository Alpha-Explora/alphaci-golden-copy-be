import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Usage: node scripts/check-onprem-agent-tag.mjs <tag> [manifest]
// Exits 0 when the tag is onprem-agent-v<version> for the manifest version,
// 1 on mismatch, and 2 on bad usage. The release workflow runs it on tag builds.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [tag, manifestArg] = process.argv.slice(2);
if (!tag) {
  console.error('Usage: node scripts/check-onprem-agent-tag.mjs <tag> [manifest]');
  process.exit(2);
}
const manifest =
  manifestArg ?? path.join(root, 'deploy/onprem/agent/release-manifest.json');
const { version } = JSON.parse(readFileSync(manifest, 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('release-manifest.json has an invalid version.');
  process.exit(2);
}
const expected = `onprem-agent-v${version}`;
if (tag !== expected) {
  console.error(
    `Tag ${tag} does not match release-manifest.json (expected ${expected}).`,
  );
  process.exit(1);
}
console.log(`Tag ${tag} matches the installer manifest.`);
