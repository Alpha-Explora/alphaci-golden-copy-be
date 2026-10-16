import { readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildShellFixture,
  shellFixture,
} from './support/onprem-shell-fixture';

describe('Machine enrollment shell installer', () => {
  beforeAll(buildShellFixture);
  it('consumes once, protects credentials, resumes a saved response, and rejects a server change', () => {
    const f = shellFixture();
    rmSync(join(f.work, 'host/machine.json'));
    rmSync(join(f.work, 'host/secrets/machine-token'));
    f.run('bash /work/host/bin/enroll https://fixture.invalid', f.code + '\n');
    f.run('bash /work/host/bin/enroll https://fixture.invalid');
    expect(
      readFileSync(join(f.work, 'requests.log'), 'utf8').trim().split('\n'),
    ).toEqual(['enroll']);
    expect(f.run('stat -c %a /work/host/secrets/machine-token').trim()).toBe(
      '600',
    );
    expect(() =>
      f.run('bash /work/host/bin/enroll https://another.invalid'),
    ).toThrow();
    expect(
      readFileSync(join(f.work, 'curl-arguments.log'), 'utf8'),
    ).not.toContain(f.code);
    rmSync(join(f.work, 'host/machine.json'));
    writeFileSync(
      join(f.work, 'host/secrets/enrollment-response.json'),
      readFileSync(join(f.work, 'receipt.json')),
    );
    f.run('bash /work/host/bin/enroll https://fixture.invalid');
    expect(
      readFileSync(join(f.work, 'requests.log'), 'utf8').trim().split('\n'),
    ).toEqual(['enroll']);
  });
  it('reads the code from ALPHACI_ENROLL_CODE_FILE, deletes the file, and keeps the code out of argv and output', () => {
    const f = shellFixture();
    rmSync(join(f.work, 'host/machine.json'));
    rmSync(join(f.work, 'host/secrets/machine-token'));
    writeFileSync(join(f.work, 'host/enroll-code'), f.code + '\n', {
      mode: 0o600,
    });
    const output = f.run(
      'ALPHACI_ENROLL_CODE_FILE=/work/host/enroll-code bash /work/host/bin/enroll https://fixture.invalid 2>&1',
    );
    expect(output).toContain('Code received from the install file');
    expect(output).not.toContain(f.code);
    expect(existsSync(join(f.work, 'host/enroll-code'))).toBe(false);
    expect(
      readFileSync(join(f.work, 'curl-arguments.log'), 'utf8'),
    ).not.toContain(f.code);
    expect(
      readFileSync(join(f.work, 'requests.log'), 'utf8').trim().split('\n'),
    ).toEqual(['enroll']);
    expect(f.run('stat -c %a /work/host/secrets/machine-token').trim()).toBe(
      '600',
    );
  });
  it('deletes a code file before it can be used, whether the code is malformed or the server refuses it', () => {
    const f = shellFixture();
    rmSync(join(f.work, 'host/machine.json'));
    rmSync(join(f.work, 'host/secrets/machine-token'));
    writeFileSync(join(f.work, 'host/enroll-code'), 'not-a-valid-code\n');
    expect(() =>
      f.run(
        'ALPHACI_ENROLL_CODE_FILE=/work/host/enroll-code bash /work/host/bin/enroll https://fixture.invalid 2>&1',
      ),
    ).toThrow();
    expect(existsSync(join(f.work, 'host/enroll-code'))).toBe(false);
    expect(existsSync(join(f.work, 'requests.log'))).toBe(false);

    writeFileSync(join(f.work, 'host/enroll-code'), f.code + '\n');
    writeFileSync(join(f.work, 'enroll-status'), '401');
    expect(() =>
      f.run(
        'ALPHACI_ENROLL_CODE_FILE=/work/host/enroll-code bash /work/host/bin/enroll https://fixture.invalid 2>&1',
      ),
    ).toThrow();
    expect(existsSync(join(f.work, 'host/enroll-code'))).toBe(false);
    expect(existsSync(join(f.work, 'host/secrets/machine-token'))).toBe(false);
  });
  it('keeps the code file when the server cannot be reached, so a retry can use it', () => {
    const f = shellFixture();
    rmSync(join(f.work, 'host/machine.json'));
    rmSync(join(f.work, 'host/secrets/machine-token'));
    writeFileSync(join(f.work, 'host/enroll-code'), f.code + '\n');
    writeFileSync(join(f.work, 'fail-enroll'), '1');
    expect(() =>
      f.run(
        'ALPHACI_ENROLL_CODE_FILE=/work/host/enroll-code bash /work/host/bin/enroll https://fixture.invalid 2>&1',
      ),
    ).toThrow();
    expect(existsSync(join(f.work, 'host/enroll-code'))).toBe(true);
    expect(existsSync(join(f.work, 'host/secrets/machine-token'))).toBe(false);
    expect(existsSync(join(f.work, 'requests.log'))).toBe(false);

    rmSync(join(f.work, 'fail-enroll'));
    const retry = f.run(
      'ALPHACI_ENROLL_CODE_FILE=/work/host/enroll-code bash /work/host/bin/enroll https://fixture.invalid 2>&1',
    );
    expect(retry).toContain('Machine enrolled');
    expect(existsSync(join(f.work, 'host/enroll-code'))).toBe(false);
    expect(
      readFileSync(join(f.work, 'requests.log'), 'utf8').trim().split('\n'),
    ).toEqual(['enroll']);
  });
  it('keeps the code file on a server error', () => {
    const f = shellFixture();
    rmSync(join(f.work, 'host/machine.json'));
    rmSync(join(f.work, 'host/secrets/machine-token'));
    writeFileSync(join(f.work, 'host/enroll-code'), f.code + '\n');
    writeFileSync(join(f.work, 'enroll-status'), '503');
    expect(() =>
      f.run(
        'ALPHACI_ENROLL_CODE_FILE=/work/host/enroll-code bash /work/host/bin/enroll https://fixture.invalid 2>&1',
      ),
    ).toThrow();
    expect(existsSync(join(f.work, 'host/enroll-code'))).toBe(true);
    expect(existsSync(join(f.work, 'host/secrets/machine-token'))).toBe(false);
  });
  it('deletes the code file only when the server refuses the code itself (400, 401, 409)', () => {
    for (const [status, deleted] of [
      ['400', true],
      ['401', true],
      ['409', true],
      ['403', false],
      ['404', false],
      ['408', false],
      ['429', false],
    ] as const) {
      const f = shellFixture();
      rmSync(join(f.work, 'host/machine.json'));
      rmSync(join(f.work, 'host/secrets/machine-token'));
      writeFileSync(join(f.work, 'host/enroll-code'), f.code + '\n');
      writeFileSync(join(f.work, 'enroll-status'), status);
      expect(() =>
        f.run(
          'ALPHACI_ENROLL_CODE_FILE=/work/host/enroll-code bash /work/host/bin/enroll https://fixture.invalid 2>&1',
        ),
      ).toThrow();
      expect(existsSync(join(f.work, 'host/enroll-code'))).toBe(!deleted);
      expect(existsSync(join(f.work, 'host/secrets/machine-token'))).toBe(
        false,
      );
    }
  });
  it('does not keep a truncated response, and keeps the code file for a retry', () => {
    const f = shellFixture();
    rmSync(join(f.work, 'host/machine.json'));
    rmSync(join(f.work, 'host/secrets/machine-token'));
    writeFileSync(join(f.work, 'host/enroll-code'), f.code + '\n');
    writeFileSync(join(f.work, 'enroll-truncate'), '1');
    expect(() =>
      f.run(
        'ALPHACI_ENROLL_CODE_FILE=/work/host/enroll-code bash /work/host/bin/enroll https://fixture.invalid 2>&1',
      ),
    ).toThrow();
    expect(
      existsSync(join(f.work, 'host/secrets/enrollment-response.json')),
    ).toBe(false);
    expect(existsSync(join(f.work, 'host/secrets/machine-token'))).toBe(false);
    expect(existsSync(join(f.work, 'host/enroll-code'))).toBe(true);
    rmSync(join(f.work, 'enroll-truncate'));
    expect(
      f.run(
        'ALPHACI_ENROLL_CODE_FILE=/work/host/enroll-code bash /work/host/bin/enroll https://fixture.invalid 2>&1',
      ),
    ).toContain('Machine enrolled');
  });
  it('consumes a replacement code only with --replace and restores the old credential when it fails', () => {
    const f = shellFixture();
    const receipt = JSON.parse(
      readFileSync(join(f.work, 'receipt.json'), 'utf8'),
    ) as { credential: string; machine: { id: string } };
    receipt.credential = 'onprem_machine_' + 'z'.repeat(43);
    writeFileSync(join(f.work, 'receipt.json'), JSON.stringify(receipt));
    const token = () =>
      readFileSync(join(f.work, 'host/secrets/machine-token'), 'utf8').trim();
    const machine = () =>
      readFileSync(join(f.work, 'host/machine.json'), 'utf8');
    const original = machine();

    expect(
      f.run(
        'bash /work/host/bin/enroll https://fixture.invalid',
        f.code + '\n',
      ),
    ).toContain('--replace');
    expect(existsSync(join(f.work, 'requests.log'))).toBe(false);

    writeFileSync(join(f.work, 'fail-enroll'), '1');
    expect(() =>
      f.run(
        'bash /work/host/bin/enroll https://fixture.invalid windows --replace',
        f.code + '\n',
      ),
    ).toThrow();
    expect(token()).toBe(f.token);
    expect(machine()).toBe(original);
    expect(f.run('ls /work/host/secrets')).not.toContain('replaced.');

    rmSync(join(f.work, 'fail-enroll'));
    f.run(
      'bash /work/host/bin/enroll --replace https://fixture.invalid windows',
      f.code + '\n',
    );
    expect(token()).toBe(receipt.credential);
    expect(JSON.parse(machine())).toMatchObject({ id: receipt.machine.id });
    expect(f.run('ls /work/host/secrets')).not.toContain('replaced.');
    expect(
      readFileSync(join(f.work, 'requests.log'), 'utf8').trim().split('\n'),
    ).toEqual(['enroll']);
  });
  it('leaves no credential after a failed response and refuses incomplete supervisor configuration', () => {
    const f = shellFixture();
    rmSync(join(f.work, 'host/machine.json'));
    rmSync(join(f.work, 'host/secrets/machine-token'));
    writeFileSync(join(f.work, 'fail-enroll'), '1');
    expect(() =>
      f.run(
        'bash /work/host/bin/enroll https://fixture.invalid',
        f.code + '\n',
      ),
    ).toThrow();
    expect(existsSync(join(f.work, 'host/secrets/machine-token'))).toBe(false);
    expect(() =>
      f.run('/work/host/bin/alphaci-supervisor --heartbeat-only'),
    ).toThrow();
    expect(existsSync(join(f.work, 'requests.log'))).toBe(false);
  });
  it('exports diagnostics without credentials or enrollment response files', () => {
    const f = shellFixture();
    writeFileSync(
      join(f.work, 'host/secrets/enrollment-response.json'),
      'SECRET-ENROLLMENT',
    );
    const archive = f
      .run('/work/host/bin/alphaci-supervisor support-bundle')
      .trim();
    const contents = f.run(`tar -tzf ${archive}; tar -xOzf ${archive}`);
    expect(contents).not.toContain(f.token);
    expect(contents).not.toContain('SECRET-ENROLLMENT');
    expect(contents).not.toContain('PRIVATE KEY');
  });
});
