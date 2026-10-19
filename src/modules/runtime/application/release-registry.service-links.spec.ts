import { ReleaseRegistryService } from './release-registry.service';
import type { ServiceLink } from '../domain/onprem-service-link';

const token = 'onprem_machine_' + 'x'.repeat(43);

function binding(id: string, projectId: string, environmentId: string) {
  return {
    id,
    projectId,
    environmentId,
    tunnelReady: false,
    publicAddress: null,
    machine: {
      id,
      machineId: 'machine',
      projectId,
      environmentId,
      revision: 1,
      config: {
        ports: [{ slot: 'frontend', hostPort: 8080, containerPort: 3000 }],
        health: [{ slot: 'frontend', path: '/' }],
        ingress: { mode: 'direct', publicUrl: null },
      },
    },
  };
}

const link: ServiceLink = {
  network: 'alphaci-0123456789ab-dev',
  env: { frontend: { API_URL: 'http://backend:4000' } },
  peers: [
    { environmentId: '11111111-1111-4111-8111-111111111111', slot: 'backend' },
  ],
};

/** One pending deployment per environment that has one in `pending`. */
function registry(
  bindings: ReturnType<typeof binding>[],
  pending: string[],
  serviceLinks?: { linksFor: jest.Mock },
  agentVersion: string | null = '0.4.0',
) {
  const releases = {
    listHostAssignments: jest.fn((environmentId: string) =>
      Promise.resolve(
        pending.includes(environmentId)
          ? [
              {
                deployment: {
                  id: 'deployment-' + environmentId,
                  projectId: bindings.find(
                    (item) => item.environmentId === environmentId,
                  )!.projectId,
                  status: 'pending',
                  targetIds: ['target'],
                },
                release: {
                  manifest: { releaseId: 'release' },
                  manifestSha256: 'hash',
                  signature: { keyId: 'key' },
                },
              },
            ]
          : [],
      ),
    ),
  };
  const machineAssignments = {
    withAuthorizedAgent: jest.fn(
      (
        _hash: string,
        _kind: string,
        read: (auth: unknown, client: unknown) => unknown,
      ) => read({ bindings, agentVersion }, {}),
    ),
  };
  const projects = {
    findProjectEnvironment: jest
      .fn()
      .mockResolvedValue({ id: 'env', role: 'non_production' }),
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
    undefined,
    serviceLinks as never,
  );
}

describe('host assignments carry the derived service link', () => {
  const frontend = binding('f', 'web', 'env-web');
  const backend = binding('b', 'api', 'env-api');

  it('puts the link beside the machine config, outside the signed envelope', async () => {
    const linksFor = jest.fn().mockResolvedValue(new Map([['f', link]]));
    const result = await registry([backend, frontend], ['env-web'], {
      linksFor,
    }).hostAssignments(token);
    expect(linksFor).toHaveBeenCalledWith([backend, frontend], new Set(['f']));
    expect(result).toEqual([
      {
        deploymentId: 'deployment-env-web',
        status: 'pending',
        assignment: {
          projectId: 'web',
          environmentId: 'env-web',
          targetIds: ['target'],
          machine: frontend.machine,
          link,
        },
        envelope: {
          manifest: { releaseId: 'release' },
          manifestSha256: 'hash',
          signature: { keyId: 'key' },
        },
      },
    ]);
  });
  it('sends exactly the old payload when an environment is not linked', async () => {
    const linksFor = jest.fn().mockResolvedValue(new Map());
    const [item] = await registry([frontend], ['env-web'], {
      linksFor,
    }).hostAssignments(token);
    expect(item).toEqual({
      deploymentId: 'deployment-env-web',
      status: 'pending',
      assignment: {
        projectId: 'web',
        environmentId: 'env-web',
        targetIds: ['target'],
        machine: frontend.machine,
      },
      envelope: {
        manifest: { releaseId: 'release' },
        manifestSha256: 'hash',
        signature: { keyId: 'key' },
      },
    });
  });
  it.each([['0.3.0'], ['0.3.9'], [null], ['0.4.0-rc1']])(
    'sends no link to an agent that reported %p, which predates links',
    async (agentVersion) => {
      const linksFor = jest.fn().mockResolvedValue(new Map([['f', link]]));
      const [item] = await registry(
        [backend, frontend],
        ['env-web'],
        { linksFor },
        agentVersion,
      ).hostAssignments(token);
      expect(linksFor).not.toHaveBeenCalled();
      expect(item?.assignment).not.toHaveProperty('link');
    },
  );
  it.each([['0.4.0'], ['0.4.1'], ['1.0.0']])(
    'sends the link to an agent that reported %s',
    async (agentVersion) => {
      const linksFor = jest.fn().mockResolvedValue(new Map([['f', link]]));
      const [item] = await registry(
        [backend, frontend],
        ['env-web'],
        { linksFor },
        agentVersion,
      ).hostAssignments(token);
      expect(item?.assignment).toHaveProperty('link', link);
    },
  );
  it('derives no links when nothing is in flight', async () => {
    const linksFor = jest.fn();
    expect(
      await registry([backend, frontend], [], { linksFor }).hostAssignments(
        token,
      ),
    ).toEqual([]);
    expect(linksFor).not.toHaveBeenCalled();
  });
  it('fails the read rather than hand out a linked environment without its link', async () => {
    const linksFor = jest.fn().mockRejectedValue(new Error('database down'));
    await expect(
      registry([backend, frontend], ['env-web'], { linksFor }).hostAssignments(
        token,
      ),
    ).rejects.toThrow('database down');
  });
});
