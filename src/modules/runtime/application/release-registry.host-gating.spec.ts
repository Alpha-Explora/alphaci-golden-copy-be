import { ReleaseRegistryService } from './release-registry.service';

const token = 'onprem_machine_' + 'x'.repeat(43);

/** A machine binding whose tunnel may or may not be running with an address. */
function binding(tunnelReady: boolean, mode: 'tunnel' | 'direct' = 'tunnel') {
  return {
    id: 'binding',
    projectId: 'project',
    environmentId: 'env',
    tunnelReady,
    machine: {
      id: 'binding',
      machineId: 'machine',
      projectId: 'project',
      environmentId: 'env',
      revision: 1,
      config: {
        ports: [{ slot: 'frontend', hostPort: 8080, containerPort: 3000 }],
        health: [{ slot: 'frontend', path: '/' }],
        ingress: { mode, publicUrl: null },
      },
    },
  };
}

/** The registry with one pending deployment in the environment, for the binding. */
function registry(bindings: unknown[], role: 'production' | 'non_production') {
  const releases = {
    listHostAssignments: jest.fn().mockResolvedValue([
      {
        deployment: {
          id: 'deployment',
          projectId: 'project',
          status: 'pending',
          targetIds: [],
        },
        release: { manifest: {}, manifestSha256: 'hash', signature: {} },
      },
    ]),
  };
  const machineAssignments = {
    withAuthorizedAgent: jest.fn(
      (
        _hash: string,
        _kind: string,
        read: (auth: unknown, client: unknown) => unknown,
      ) => read({ bindings }, {}),
    ),
  };
  const projects = {
    findProjectEnvironment: jest.fn().mockResolvedValue({ id: 'env', role }),
  };
  const configService = {
    getOrThrow: () => ({ envProvisioning: { enabled: true } }),
    get: (key: string) =>
      key === 'ONPREM_RELEASES_ENABLED' ? 'true' : undefined,
  };
  return new ReleaseRegistryService(
    releases as never,
    {} as never,
    projects as never,
    {} as never,
    configService as never,
    {} as never,
    undefined,
    undefined,
    machineAssignments as never,
  );
}

describe('host assignments gate production on a running tunnel', () => {
  it('hands production to a machine only once its tunnel is running', async () => {
    const waiting = registry([binding(false)], 'production');
    expect(await waiting.hostAssignments(token)).toEqual([]);
    const running = registry([binding(true)], 'production');
    expect(await running.hostAssignments(token)).toHaveLength(1);
  });
  it('does not hold other environments for a tunnel', async () => {
    const nonProduction = registry([binding(false)], 'non_production');
    expect(await nonProduction.hostAssignments(token)).toHaveLength(1);
  });
  it('does not gate production assignments that use direct access', async () => {
    const direct = registry([binding(false, 'direct')], 'production');
    expect(await direct.hostAssignments(token)).toHaveLength(1);
  });
});
