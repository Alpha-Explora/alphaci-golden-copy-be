/** How the platform serves HTTPS. See the TLS notes in alphaci.env.example. */
export type TlsMode = 'auto' | 'internal' | 'custom';

export type CliCommand =
  | {
      readonly name: 'init';
      readonly hostname: string;
      readonly tls: TlsMode;
      readonly dir: string;
    }
  | { readonly name: 'admin-grant'; readonly githubLogin: string }
  | { readonly name: 'doctor' }
  | {
      readonly name: 'host-enrollment';
      readonly team: string;
      readonly githubLogin: string;
      readonly hostName: string;
    }
  | { readonly name: 'help' };

/** A mistake in the command line. The message is shown to the operator as is. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const USAGE = `alphaci-ctl - setup helper for the self-hosted AlphaCI appliance

Commands:
  init <hostname> [--tls auto|internal|custom] [--dir <path>]
      Write alphaci.env and generate secrets/ (session secret, database
      password and URL, P-256 release signing key). Existing files are kept.
  admin-grant --github-login <login>
      Make an existing AlphaCI user a platform super-admin. The user must have
      signed in once.
  host-enrollment --team <name or ID> --github-login <login> [--name <host name>]
      Create a one-time enrollment code for an on-prem host and print it. Used by
      server-host to enroll this server's own agent.
  doctor
      Check the database, migrations, signing key, required settings, outbound
      HTTPS and the public API address.
  help
      Show this text.`;

const TLS_MODES: readonly TlsMode[] = ['auto', 'internal', 'custom'];

/**
 * Parses argv after the program name. Flags take their value from the next
 * argument; `--flag=value` is accepted too. Unknown flags are errors, so a typo
 * never silently changes what a command does.
 */
export function parseArgs(argv: readonly string[]): CliCommand {
  const [command, ...rest] = argv;
  if (
    command === undefined ||
    command === 'help' ||
    command === '--help' ||
    command === '-h'
  ) {
    return { name: 'help' };
  }

  const { positionals, flags } = splitFlags(rest, KNOWN_FLAGS[command] ?? []);

  switch (command) {
    case 'init': {
      const hostname = flags.get('hostname') ?? positionals[0];
      if (
        positionals.length > 1 ||
        (flags.has('hostname') && positionals.length > 0)
      ) {
        throw new UsageError(
          'init takes one hostname, for example: alphaci-ctl init alphaci.example.com',
        );
      }
      if (!hostname) {
        throw new UsageError(
          'init needs the public hostname, for example: alphaci-ctl init alphaci.example.com',
        );
      }
      const tls = flags.get('tls') ?? 'auto';
      if (!isTlsMode(tls)) {
        throw new UsageError(
          `--tls must be one of ${TLS_MODES.join(', ')} (got "${tls}").`,
        );
      }
      return {
        name: 'init',
        hostname,
        tls,
        dir: flags.get('dir') ?? process.cwd(),
      };
    }
    case 'admin-grant': {
      if (positionals.length > 0) {
        throw new UsageError(
          'admin-grant takes the login as --github-login <login>.',
        );
      }
      const githubLogin = flags.get('github-login');
      if (!githubLogin) {
        throw new UsageError('admin-grant needs --github-login <login>.');
      }
      return { name: 'admin-grant', githubLogin };
    }
    case 'host-enrollment': {
      const team = flags.get('team');
      const githubLogin = flags.get('github-login');
      if (positionals.length > 0 || !team || !githubLogin) {
        throw new UsageError(
          'host-enrollment needs --team <name or ID> and --github-login <login>.',
        );
      }
      return {
        name: 'host-enrollment',
        team,
        githubLogin,
        hostName: flags.get('name') ?? 'alphaci-server',
      };
    }
    case 'doctor': {
      if (positionals.length > 0) {
        throw new UsageError('doctor takes no arguments.');
      }
      return { name: 'doctor' };
    }
    default:
      throw new UsageError(
        `Unknown command "${command}". Run alphaci-ctl help.`,
      );
  }
}

function isTlsMode(value: string): value is TlsMode {
  return (TLS_MODES as readonly string[]).includes(value);
}

/** Flags each command accepts. A flag outside this list is refused by name. */
const KNOWN_FLAGS: Readonly<Record<string, readonly string[]>> = {
  init: ['tls', 'dir', 'hostname'],
  'admin-grant': ['github-login'],
  doctor: [],
  'host-enrollment': ['team', 'github-login', 'name'],
};

function splitFlags(
  args: readonly string[],
  allowed: readonly string[],
): {
  positionals: string[];
  flags: Map<string, string>;
} {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (name === '') {
      throw new UsageError('Empty flag name.');
    }
    if (!allowed.includes(name)) {
      throw new UsageError(`This command does not accept --${name}.`);
    }
    let value: string | undefined;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`--${name} needs a value.`);
      }
      value = next;
      i += 1;
    }
    if (value.trim() === '') {
      throw new UsageError(`--${name} needs a value.`);
    }
    flags.set(name, value.trim());
  }
  return { positionals, flags };
}
