import { parseArgs, UsageError } from './args';

describe('parseArgs', () => {
  it('shows help when no command is given', () => {
    expect(parseArgs([])).toEqual({ name: 'help' });
    expect(parseArgs(['--help'])).toEqual({ name: 'help' });
  });

  it('takes the init hostname as a positional argument with auto TLS by default', () => {
    expect(
      parseArgs(['init', 'alphaci.example.com', '--dir', '/selfhost']),
    ).toEqual({
      name: 'init',
      hostname: 'alphaci.example.com',
      tls: 'auto',
      dir: '/selfhost',
    });
  });

  it('accepts --hostname, --tls=internal and the = form of flags', () => {
    expect(
      parseArgs(['init', '--hostname=alphaci.lab', '--tls=internal']),
    ).toEqual({
      name: 'init',
      hostname: 'alphaci.lab',
      tls: 'internal',
      dir: process.cwd(),
    });
  });

  it('rejects an unknown TLS mode', () => {
    expect(() =>
      parseArgs(['init', 'a.example.com', '--tls', 'letsencrypt']),
    ).toThrow(UsageError);
  });

  it('requires a hostname for init', () => {
    expect(() => parseArgs(['init'])).toThrow(/needs the public hostname/);
  });

  it('rejects two hostnames', () => {
    expect(() => parseArgs(['init', 'a.example.com', 'b.example.com'])).toThrow(
      /takes one hostname/,
    );
  });

  it('rejects a flag the command does not accept', () => {
    expect(() => parseArgs(['doctor', '--fix'])).toThrow(
      /does not accept --fix/,
    );
    expect(() =>
      parseArgs(['init', 'a.example.com', '--github-login', 'x']),
    ).toThrow(/does not accept --github-login/);
  });

  it('requires a value after a flag', () => {
    expect(() => parseArgs(['init', 'a.example.com', '--tls'])).toThrow(
      /--tls needs a value/,
    );
    expect(() =>
      parseArgs(['init', 'a.example.com', '--tls', '--dir', '/x']),
    ).toThrow(/--tls needs a value/);
  });

  it('parses admin-grant with --github-login', () => {
    expect(parseArgs(['admin-grant', '--github-login', 'lloydlim1'])).toEqual({
      name: 'admin-grant',
      githubLogin: 'lloydlim1',
    });
  });

  it('requires --github-login for admin-grant and refuses a bare positional login', () => {
    expect(() => parseArgs(['admin-grant'])).toThrow(/needs --github-login/);
    expect(() => parseArgs(['admin-grant', 'lloydlim1'])).toThrow(
      /as --github-login/,
    );
  });

  it('takes no arguments for doctor', () => {
    expect(parseArgs(['doctor'])).toEqual({ name: 'doctor' });
    expect(() => parseArgs(['doctor', 'extra'])).toThrow(/takes no arguments/);
  });

  it('names an unknown command', () => {
    expect(() => parseArgs(['upgrade'])).toThrow(/Unknown command "upgrade"/);
  });
});
