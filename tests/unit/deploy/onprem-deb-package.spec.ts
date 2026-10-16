import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The package layout is what the Ubuntu install depends on: this stages the tree
// with the packager (no dpkg-deb needed) and checks what the operator will get.
const packager = resolve('scripts/package-onprem-agent-deb.mjs');
const manifest = JSON.parse(
  readFileSync(resolve('deploy/onprem/agent/release-manifest.json'), 'utf8'),
) as { version: string };
const isWindows = process.platform === 'win32';
const linuxOnly = isWindows ? describe.skip : describe;

let stage: string;
beforeAll(() => {
  stage = mkdtempSync(join(tmpdir(), 'alphaci-deb-'));
  execFileSync(process.execPath, [packager, '--stage-only', stage], {
    encoding: 'utf8',
  });
});

const read = (relativePath: string) =>
  readFileSync(join(stage, relativePath), 'utf8');

it('lays the agent out under /opt/alphaci with the machine units and the enrollment command', () => {
  for (const file of [
    'opt/alphaci/bin/alphaci-supervisor',
    'opt/alphaci/bin/render-assignment',
    'opt/alphaci/bin/enroll',
    'opt/alphaci/bin/ubuntu-prerequisites.sh',
    'usr/bin/alphaci-enroll',
    'usr/lib/systemd/system/alphaci-machine.service',
    'usr/lib/systemd/system/alphaci-machine.timer',
    'DEBIAN/control',
    'DEBIAN/postinst',
    'DEBIAN/prerm',
    'DEBIAN/postrm',
  ])
    expect(existsSync(join(stage, file))).toBe(true);
  // The supervisor runs opt/alphaci/bin/alphaci-agent for each assignment, so the
  // package must ship it there, not under /usr.
  expect(existsSync(join(stage, 'opt/alphaci/bin/alphaci-agent'))).toBe(true);
  expect(existsSync(join(stage, 'usr/bin/alphaci-agent'))).toBe(false);
  expect(existsSync(join(stage, 'etc/systemd'))).toBe(false);
});

it('ships every /opt/alphaci/bin program that the shipped scripts run', () => {
  const shipped = [
    'opt/alphaci/bin/alphaci-supervisor',
    'opt/alphaci/bin/alphaci-agent',
    'opt/alphaci/bin/render-assignment',
    'opt/alphaci/bin/enroll',
    'opt/alphaci/bin/ubuntu-prerequisites.sh',
    'usr/bin/alphaci-enroll',
  ];
  const called = new Set<string>();
  for (const file of shipped)
    for (const match of read(file).matchAll(
      /(?:\$ROOT|\/opt\/alphaci)\/bin\/([A-Za-z0-9._-]+)/g,
    ))
      called.add(match[1]);
  expect(called.size).toBeGreaterThan(0);
  for (const name of called)
    expect(existsSync(join(stage, 'opt/alphaci/bin', name))).toBe(true);
});

it('declares an architecture-independent package for this agent version', () => {
  const control = read('DEBIAN/control');
  expect(control).toContain('Package: alphaci-agent\n');
  expect(control).toContain(`Version: ${manifest.version}\n`);
  expect(control).toContain('Architecture: all\n');
  expect(control).toMatch(/^Depends: .*\bcurl\b.*\bjq\b.*\butil-linux\b/m);
  expect(control).toMatch(/^Maintainer: .+ <[^>]+>$/m);
});

it('does not enroll or start polling on install', () => {
  const postinst = read('DEBIAN/postinst');
  expect(postinst).toContain('configure)');
  expect(postinst).not.toMatch(/opt\/alphaci\/bin\/enroll|alphaci-supervisor/);
  expect(postinst).not.toMatch(/systemctl\s+(enable|start|restart)/);
  // Removing the package stops polling; upgrades keep the timer running.
  expect(read('DEBIAN/prerm')).toMatch(
    /remove\|deconfigure\)[\s\S]*systemctl disable --now alphaci-machine\.timer/,
  );
});

linuxOnly('shell files in the package', () => {
  it('have valid syntax and the expected permissions', () => {
    for (const file of [
      'usr/bin/alphaci-enroll',
      'opt/alphaci/bin/ubuntu-prerequisites.sh',
      'opt/alphaci/bin/enroll',
    ]) {
      expect(spawnSync('bash', ['-n', join(stage, file)]).status).toBe(0);
    }
    expect(spawnSync('sh', ['-n', join(stage, 'DEBIAN/postinst')]).status).toBe(
      0,
    );
    expect(spawnSync('sh', ['-n', join(stage, 'DEBIAN/prerm')]).status).toBe(0);
    expect(spawnSync('sh', ['-n', join(stage, 'DEBIAN/postrm')]).status).toBe(
      0,
    );
    expect(statSync(join(stage, 'usr/bin/alphaci-enroll')).mode & 0o777).toBe(
      0o755,
    );
    expect(statSync(join(stage, 'DEBIAN/postinst')).mode & 0o777).toBe(0o755);
  });
  it('refuses to run without root before touching anything', () => {
    if (process.getuid?.() === 0) return;
    const result = spawnSync(
      'bash',
      [join(stage, 'usr/bin/alphaci-enroll'), 'https://api.example.com'],
      {
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('sudo');
  });
});
