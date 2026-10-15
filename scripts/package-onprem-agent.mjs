import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(
  readFileSync(
    path.join(root, 'deploy/onprem/agent/release-manifest.json'),
    'utf8',
  ),
);
if (!/^\d+\.\d+\.\d+$/.test(release.version))
  throw new Error('Invalid installer version');
const output = path.join(root, 'artifacts/onprem');
mkdirSync(output, { recursive: true });
const name = `alphaci-agent-${release.version}.tar.gz`,
  archive = path.join(output, name);
execFileSync(
  'tar',
  [
    '-czf',
    archive,
    '-C',
    path.join(root, 'deploy/onprem'),
    'agent',
    'compose',
    'windows',
  ],
  { stdio: 'inherit' },
);
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(path.join(output, name + '.sha256'), `${sha256}  ${name}\n`);
writeFileSync(
  path.join(output, 'installer-release.json'),
  JSON.stringify({ ...release, file: name, sha256 }, null, 2) + '\n',
);
console.log(
  JSON.stringify({ version: release.version, path: archive, sha256 }),
);
