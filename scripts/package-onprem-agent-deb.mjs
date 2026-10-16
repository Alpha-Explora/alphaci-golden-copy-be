import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Builds alphaci-agent_<version>_all.deb for Ubuntu. The package lays the agent
// out under /opt/alphaci and installs the machine units. Its postinst does not
// enroll: the operator runs `sudo alphaci-enroll <API URL>` once.
// Usage: node scripts/package-onprem-agent-deb.mjs [--stage-only <directory>]
// --stage-only lays out the package tree without dpkg-deb (for tests).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// [source, installed path, mode]
export const PACKAGE_FILES = [
  [
    'deploy/onprem/agent/alphaci-supervisor.sh',
    'opt/alphaci/bin/alphaci-supervisor',
    0o755,
  ],
  // The supervisor runs this for each assignment (render-assignment.sh), so it ships too.
  [
    'deploy/onprem/agent/alphaci-agent.sh',
    'opt/alphaci/bin/alphaci-agent',
    0o755,
  ],
  [
    'deploy/onprem/agent/render-assignment.sh',
    'opt/alphaci/bin/render-assignment',
    0o755,
  ],
  ['deploy/onprem/agent/enroll.sh', 'opt/alphaci/bin/enroll', 0o755],
  [
    'deploy/onprem/agent/ubuntu-prerequisites.sh',
    'opt/alphaci/bin/ubuntu-prerequisites.sh',
    0o644,
  ],
  ['deploy/onprem/deb/alphaci-enroll', 'usr/bin/alphaci-enroll', 0o755],
  [
    'deploy/onprem/agent/alphaci-machine.service',
    'usr/lib/systemd/system/alphaci-machine.service',
    0o644,
  ],
  [
    'deploy/onprem/agent/alphaci-machine.timer',
    'usr/lib/systemd/system/alphaci-machine.timer',
    0o644,
  ],
  // The automatic-address tunnels: each unit runs tunnel-run, which runs cloudflared.
  // cloudflared itself is installed on the machine separately; this package does not ship it.
  ['deploy/onprem/agent/tunnel.sh', 'opt/alphaci/bin/tunnel.sh', 0o644],
  ['deploy/onprem/agent/tunnel-run.sh', 'opt/alphaci/bin/tunnel-run', 0o755],
  [
    'deploy/onprem/agent/alphaci-tunnel@.service',
    'usr/lib/systemd/system/alphaci-tunnel@.service',
    0o644,
  ],
];
// [source, name under DEBIAN/]
export const MAINTAINER_SCRIPTS = [
  ['deploy/onprem/deb/postinst', 'postinst'],
  ['deploy/onprem/deb/prerm', 'prerm'],
  ['deploy/onprem/deb/postrm', 'postrm'],
];

export function releaseVersion(
  manifest = path.join(root, 'deploy/onprem/agent/release-manifest.json'),
) {
  const { version } = JSON.parse(readFileSync(manifest, 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('Invalid installer version');
  return version;
}

export function controlFile(version) {
  return [
    'Package: alphaci-agent',
    `Version: ${version}`,
    'Section: admin',
    'Priority: optional',
    'Architecture: all',
    'Maintainer: AlphaCI <noreply@alphaexplora.com>',
    'Depends: bash, ca-certificates, coreutils, curl, iproute2, jq, openssl, systemd, util-linux',
    'Recommends: docker-ce | docker.io, docker-compose-plugin | docker-compose-v2',
    'Description: AlphaCI on-prem machine agent',
    ' Polls AlphaCI for the environments assigned to this machine and runs them with',
    ' Docker Compose. Install the package, then enroll once: sudo alphaci-enroll <API URL>.',
    '',
  ].join('\n');
}

function install(stage, relativePath, mode, source) {
  const target = path.join(stage, relativePath);
  // dpkg-deb rejects directories group- or world-writable, so the mode is explicit
  // rather than whatever the host's umask and filesystem happen to give.
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  copyFileSync(source, target);
  chmodSync(target, mode);
}

export function stagePackage(stage, version = releaseVersion()) {
  rmSync(stage, { recursive: true, force: true });
  for (const [source, target, mode] of PACKAGE_FILES)
    install(stage, target, mode, path.join(root, source));
  for (const [source, name] of MAINTAINER_SCRIPTS)
    install(stage, path.join('DEBIAN', name), 0o755, path.join(root, source));
  const control = path.join(stage, 'DEBIAN/control');
  writeFileSync(control, controlFile(version));
  chmodSync(control, 0o644);
  return stage;
}

export function packageDeb(output = path.join(root, 'artifacts/onprem')) {
  const version = releaseVersion();
  mkdirSync(output, { recursive: true });
  const name = `alphaci-agent_${version}_all.deb`;
  const archive = path.join(output, name);
  const stage = path.join(output, `.stage-alphaci-agent-${version}`);
  stagePackage(stage, version);
  rmSync(archive, { force: true });
  // --root-owner-group records root as the owner of every file without fakeroot.
  execFileSync('dpkg-deb', ['--root-owner-group', '--build', stage, archive], {
    stdio: 'inherit',
  });
  rmSync(stage, { recursive: true, force: true });
  const sha256 = createHash('sha256')
    .update(readFileSync(archive))
    .digest('hex');
  writeFileSync(path.join(output, name + '.sha256'), `${sha256}  ${name}\n`);
  return { version, path: archive, sha256 };
}

function main(args) {
  if (args[0] === '--stage-only') {
    if (!args[1]) throw new Error('Usage: --stage-only <directory>');
    stagePackage(path.resolve(args[1]));
    return;
  }
  console.log(JSON.stringify(packageDeb()));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2));
}
