export interface RecordedCall {
  port: string;
  method: string;
  args: unknown[];
}

// Nest probes providers for lifecycle hooks, and await probes for "then".
const NOT_A_PORT_METHOD = new Set([
  'then',
  'constructor',
  'toJSON',
  'onModuleInit',
  'onApplicationBootstrap',
  'onModuleDestroy',
  'beforeApplicationShutdown',
  'onApplicationShutdown',
]);

type Member = (...args: unknown[]) => unknown;

export interface RecordingPortBehaviour {
  /** Synchronous, side-effect-free members, answered without recording. */
  silent?: Record<string, Member>;
  /** External calls a scenario expects: recorded, then answered. */
  answers?: Record<string, Member>;
}

/**
 * Stand-in for an external provider port. Every call is recorded and fails,
 * so a scenario that reaches a provider it did not expect fails loudly, and a
 * scenario can assert that no external write happened.
 */
export function recordingPort(
  port: string,
  calls: RecordedCall[],
  { silent = {}, answers = {} }: RecordingPortBehaviour = {},
): object {
  const has = (members: Record<string, Member>, name: string) =>
    Object.prototype.hasOwnProperty.call(members, name);
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === 'symbol' || NOT_A_PORT_METHOD.has(property)) {
          return undefined;
        }
        if (has(silent, property)) return silent[property];
        return (...args: unknown[]) => {
          calls.push({ port, method: property, args });
          if (has(answers, property)) return answers[property]!(...args);
          return Promise.reject(
            new Error(
              'E2E: unexpected external call ' + port + '.' + property + '.',
            ),
          );
        };
      },
    },
  );
}
