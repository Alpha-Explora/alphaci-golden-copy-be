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

/**
 * Stand-in for an external provider port. Every call is recorded and fails,
 * so a scenario that reaches a provider it did not expect fails loudly, and a
 * scenario can assert that no external write happened.
 *
 * `known` answers the port's synchronous, side-effect-free members, such as
 * callback registration at construction time; those calls are not recorded.
 */
export function recordingPort(
  port: string,
  calls: RecordedCall[],
  known: Record<string, (...args: unknown[]) => unknown> = {},
): object {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === 'symbol' || NOT_A_PORT_METHOD.has(property)) {
          return undefined;
        }
        if (Object.prototype.hasOwnProperty.call(known, property)) {
          return known[property];
        }
        return (...args: unknown[]) => {
          calls.push({ port, method: property, args });
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
