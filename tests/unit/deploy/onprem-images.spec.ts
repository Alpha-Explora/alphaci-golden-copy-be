import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';

// The self-enrolling images: cloud-init user-data for a VM, and the WSL overlay and
// first-boot unit. The renderer and overlay mode run anywhere Node runs; the shell
// pieces need a POSIX shell, so they run on Linux runners.
const renderer = resolve('scripts/render-onprem-user-data.mjs');
const builder = resolve('scripts/build-onprem-wsl-distro.sh');
const firstBoot = resolve(
  'deploy/onprem/images/first-boot/alphaci-first-boot.sh',
);
const isWindows = process.platform === 'win32';
const posixOnly = isWindows ? describe.skip : describe;

const CODE = 'Ab0_'.repeat(10) + 'Cd1';
const API = 'https://api.example.com';
const ARCHIVE_URL =
  'https://github.com/Alpha-Explora/alphaci-golden-copy-be/releases/download/onprem-agent-v0.1.0/alphaci-agent-0.1.0.tar.gz';

const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

function workdir() {
  return mkdtempSync(join(tmpdir(), 'alphaci-images-'));
}

function render(options: {
  api?: string;
  archiveUrl?: string;
  archiveSha256?: string;
  code?: string;
}) {
  const directory = workdir();
  const codeFile = join(directory, 'code');
  writeFileSync(codeFile, (options.code ?? CODE) + '\n');
  return spawnSync(
    process.execPath,
    [
      renderer,
      '--api',
      options.api ?? API,
      '--archive-url',
      options.archiveUrl ?? ARCHIVE_URL,
      '--archive-sha256',
      options.archiveSha256 ?? 'a'.repeat(64),
      '--code-file',
      codeFile,
    ],
    { encoding: 'utf8' },
  );
}

describe('cloud-init user-data for an Ubuntu VM', () => {
  it('carries the code only in the root-only enrollment file and inlines the first-boot script and unit', () => {
    const result = render({});
    expect(result.status).toBe(0);
    const userData = result.stdout;
    expect(userData.startsWith('#cloud-config\n')).toBe(true);
    expect(userData.split(CODE).length - 1).toBe(1);

    const config = load(userData) as {
      write_files: { path: string; permissions: string; content: string }[];
      runcmd: unknown[];
    };
    const file = (path: string) => {
      const entry = config.write_files.find((item) => item.path === path);
      if (!entry) throw new Error(`no ${path}`);
      return entry;
    };
    expect(file('/etc/alphaci/enrollment-code')).toMatchObject({
      permissions: '0600',
    });
    expect(file('/etc/alphaci/enrollment-code').content.trim()).toBe(CODE);
    expect(file('/etc/alphaci/first-boot.env').content).toContain(
      `ALPHACI_API_URL='${API}'`,
    );
    expect(file('/etc/alphaci/first-boot.env').content).toContain(
      `ALPHACI_ARCHIVE_SHA256='${'a'.repeat(64)}'`,
    );
    const script = file('/usr/local/sbin/alphaci-first-boot').content;
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(script).toContain('bash "$work/agent/install.sh" --enroll');
    expect(script).not.toContain('{{');
    expect(
      file('/etc/systemd/system/alphaci-first-boot.service').content,
    ).toContain('ConditionPathExists=/etc/alphaci/enrollment-code');
    expect(config.runcmd).toContainEqual([
      'systemctl',
      'enable',
      '--now',
      'alphaci-first-boot.service',
    ]);
  });

  it('refuses a malformed code, a non-HTTPS address and a bad checksum, without echoing the code', () => {
    for (const bad of [
      { code: 'short' },
      { code: 'x'.repeat(43) + ' ;rm' },
      { api: 'http://api.example.com' },
      { api: 'https://user:secret@api.example.com' },
      { archiveUrl: 'https://example.com/a?x=1' },
      { archiveSha256: 'NOT-HEX' },
    ]) {
      const result = render(bad);
      expect(result.status).toBe(1);
      expect(result.stderr + result.stdout).not.toContain(CODE);
    }
  });
});

posixOnly('WSL distro overlay and first boot', () => {
  let directory: string;
  let archive: string;
  let archiveSha: string;
  beforeAll(() => {
    directory = workdir();
    // A stand-in installer archive: its install.sh records how it was called.
    const source = join(directory, 'source', 'agent');
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, 'install.sh'),
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" > "$RECORD/enroll-args"',
        'printf "%s" "$ALPHACI_ENROLL_CODE_FILE" > "$RECORD/enroll-code-path"',
        'cat "$ALPHACI_ENROLL_CODE_FILE" > "$RECORD/enroll-code-seen"',
        'rm -f -- "$ALPHACI_ENROLL_CODE_FILE"',
        '',
      ].join('\n'),
    );
    archive = join(directory, 'alphaci-agent.tar.gz');
    execFileSync('tar', [
      '-czf',
      archive,
      '-C',
      join(directory, 'source'),
      'agent',
    ]);
    archiveSha = sha256(readFileSync(archive));
  });

  it('writes systemd boot, the archive, the first-boot environment and the enable link, but no code', () => {
    const overlay = join(workdir(), 'root');
    mkdirSync(overlay, { recursive: true });
    const result = spawnSync(
      'bash',
      [
        builder,
        '--overlay-only',
        overlay,
        '--api',
        API,
        '--archive',
        archive,
        '--archive-sha256',
        archiveSha,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(readFileSync(join(overlay, 'etc/wsl.conf'), 'utf8')).toContain(
      'systemd=true',
    );
    expect(
      readFileSync(join(overlay, 'etc/alphaci/first-boot.env'), 'utf8'),
    ).toContain(
      "ALPHACI_ARCHIVE_PATH='/opt/alphaci-installer/alphaci-agent.tar.gz'",
    );
    expect(
      readFileSync(
        join(overlay, 'opt/alphaci-installer/alphaci-agent.tar.gz'),
      ).equals(readFileSync(archive)),
    ).toBe(true);
    expect(
      statSync(join(overlay, 'usr/local/sbin/alphaci-first-boot')).mode & 0o777,
    ).toBe(0o755);
    expect(
      readlinkSync(
        join(
          overlay,
          'etc/systemd/system/multi-user.target.wants/alphaci-first-boot.service',
        ),
      ),
    ).toBe('../alphaci-first-boot.service');
    expect(existsSync(join(overlay, 'etc/alphaci/enrollment-code'))).toBe(
      false,
    );
  });

  it('refuses an archive whose checksum does not match', () => {
    const overlay = join(workdir(), 'root');
    mkdirSync(overlay, { recursive: true });
    const result = spawnSync(
      'bash',
      [
        builder,
        '--overlay-only',
        overlay,
        '--api',
        API,
        '--archive',
        archive,
        '--archive-sha256',
        'b'.repeat(64),
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(existsSync(join(overlay, 'etc/alphaci'))).toBe(false);
  });

  // Runs the first-boot unit's script against a fake /etc/alphaci and a fake systemctl.
  function runFirstBoot({ code = true, sha = archiveSha } = {}) {
    const root = workdir();
    const etc = join(root, 'etc');
    const bin = join(root, 'bin');
    const record = join(root, 'record');
    mkdirSync(etc);
    mkdirSync(bin);
    mkdirSync(record);
    writeFileSync(
      join(etc, 'first-boot.env'),
      [
        `ALPHACI_API_URL='${API}'`,
        `ALPHACI_ARCHIVE_PATH='${archive}'`,
        `ALPHACI_ARCHIVE_SHA256='${sha}'`,
        '',
      ].join('\n'),
    );
    if (code)
      writeFileSync(join(etc, 'enrollment-code'), CODE + '\n', { mode: 0o600 });
    writeFileSync(
      join(bin, 'systemctl'),
      `#!/bin/bash\necho "$*" >> "${record}/systemctl"\n`,
      { mode: 0o755 },
    );
    const result = spawnSync('bash', [firstBoot], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        ALPHACI_IMAGE_ETC: etc,
        RECORD: record,
      },
    });
    const read = (name: string) =>
      existsSync(join(record, name))
        ? readFileSync(join(record, name), 'utf8')
        : null;
    return {
      result,
      etc,
      enrollArgs: read('enroll-args'),
      codePath: read('enroll-code-path'),
      codeSeen: read('enroll-code-seen'),
      systemctl: read('systemctl'),
    };
  }

  it('enrolls from the code file, deletes it, and disables its own unit', () => {
    const run = runFirstBoot();
    expect(run.result.status).toBe(0);
    expect(run.enrollArgs).toBe(`--enroll ${API}\n`);
    expect(run.codePath).toBe(join(run.etc, 'enrollment-code'));
    expect(run.codeSeen?.trim()).toBe(CODE);
    expect(existsSync(join(run.etc, 'enrollment-code'))).toBe(false);
    expect(run.systemctl).toBe('disable alphaci-first-boot.service\n');
  });

  it('does nothing without a code, and leaves the unit enabled for the next boot', () => {
    const run = runFirstBoot({ code: false });
    expect(run.result.status).toBe(1);
    expect(run.enrollArgs).toBeNull();
    expect(run.systemctl).toBeNull();
  });

  it('installs nothing and keeps the unit enabled when the archive does not match', () => {
    const run = runFirstBoot({ sha: 'c'.repeat(64) });
    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain('checksum mismatch');
    expect(run.enrollArgs).toBeNull();
    expect(run.systemctl).toBeNull();
    expect(lstatSync(join(run.etc, 'enrollment-code')).isFile()).toBe(true);
  });
});
