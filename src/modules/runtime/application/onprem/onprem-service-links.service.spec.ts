import type { MachineBinding } from '../../infrastructure/repositories/onprem-assignments.repository';
import { serviceLinkNetwork } from '../../domain/onprem-service-link';
import { OnpremServiceLinksService } from './onprem-service-links.service';

const BACKEND_ENV = '11111111-1111-4111-8111-111111111111';
const FRONTEND_ENV = '22222222-2222-4222-8222-222222222222';

function binding(
  id: string,
  projectId: string,
  environmentId: string,
  slots: Array<'frontend' | 'backend'>,
  publicAddress: string | null = null,
): MachineBinding {
  return {
    id,
    projectId,
    environmentId,
    publicAddress,
    machine: {
      id,
      machineId: 'machine',
      projectId,
      environmentId,
      revision: 1,
      config: {
        ports: slots.map((slot, index) => ({
          slot,
          hostPort: 8080 + index,
          containerPort: slot === 'backend' ? 4000 : 3000,
        })),
        health: slots.map((slot) => ({ slot, path: '/' })),
        ingress: { mode: 'direct', publicUrl: null },
      },
    },
  };
}

function service(
  folders: Record<string, string[]>,
  slugs: Record<string, string>,
) {
  const getProjectFolder = jest.fn((projectId: string) => {
    const entry = Object.entries(folders).find(([, members]) =>
      members.includes(projectId),
    );
    return Promise.resolve(
      entry
        ? {
            deliveryProjectId: entry[0],
            groupId: 'group',
            name: entry[0],
            repositories: [
              ...entry[1].map((member) => ({
                projectId: member,
                name: member,
                repoFullName: `acme/${member}`,
              })),
              // A repository row not linked to an AlphaCI project is ignored.
              { projectId: null, name: 'docs', repoFullName: 'acme/docs' },
            ],
          }
        : null,
    );
  });
  const findProjectEnvironment = jest.fn(
    (_projectId: string, environmentId: string) =>
      Promise.resolve(
        slugs[environmentId]
          ? {
              id: environmentId,
              slug: slugs[environmentId],
              role: 'non_production',
            }
          : null,
      ),
  );
  return {
    links: new OnpremServiceLinksService(
      { getProjectFolder } as never,
      { findProjectEnvironment } as never,
    ),
    getProjectFolder,
    findProjectEnvironment,
  };
}

describe('OnpremServiceLinksService', () => {
  const backend = binding('b', 'api', BACKEND_ENV, ['backend']);
  const frontend = binding(
    'f',
    'web',
    FRONTEND_ENV,
    ['frontend'],
    'https://quiet-fox.trycloudflare.com',
  );
  const slugs = { [BACKEND_ENV]: 'dev', [FRONTEND_ENV]: 'dev' };

  it('links both halves of a pair filed under one delivery project on the same machine', async () => {
    const { links } = service({ shop: ['api', 'web'] }, slugs);
    const result = await links.linksFor(
      [backend, frontend],
      new Set(['b', 'f']),
    );
    const network = serviceLinkNetwork(BACKEND_ENV, FRONTEND_ENV, 'dev');
    expect(result.get('f')).toEqual({
      network,
      env: { frontend: { API_URL: 'http://backend:4000' } },
      peers: [{ environmentId: BACKEND_ENV, slot: 'backend' }],
    });
    expect(result.get('b')).toEqual({
      network,
      env: {
        backend: {
          FRONTEND_URL: 'https://quiet-fox.trycloudflare.com',
          CORS_ORIGINS: 'https://quiet-fox.trycloudflare.com',
        },
      },
      peers: [{ environmentId: FRONTEND_ENV, slot: 'frontend' }],
    });
  });
  it('derives only the requested bindings', async () => {
    const { links } = service({ shop: ['api', 'web'] }, slugs);
    const result = await links.linksFor([backend, frontend], new Set(['f']));
    expect([...result.keys()]).toEqual(['f']);
  });
  it('does not link when the other half is not on this machine', async () => {
    const { links, getProjectFolder } = service(
      { shop: ['api', 'web'] },
      slugs,
    );
    expect((await links.linksFor([frontend], new Set(['f']))).size).toBe(0);
    expect(getProjectFolder).not.toHaveBeenCalled();
  });
  it('does not link projects filed under different delivery projects', async () => {
    const { links } = service({ shop: ['api'], blog: ['web'] }, slugs);
    expect(
      (await links.linksFor([backend, frontend], new Set(['b', 'f']))).size,
    ).toBe(0);
  });
  it('does not link a project that is in no delivery project', async () => {
    const { links } = service({}, slugs);
    expect(
      (await links.linksFor([backend, frontend], new Set(['b', 'f']))).size,
    ).toBe(0);
  });
  it('does not link environments with different slugs', async () => {
    const { links } = service(
      { shop: ['api', 'web'] },
      { [BACKEND_ENV]: 'dev', [FRONTEND_ENV]: 'uat' },
    );
    expect(
      (await links.linksFor([backend, frontend], new Set(['b', 'f']))).size,
    ).toBe(0);
  });
  it('ignores legacy bindings and single apps that run both slots', async () => {
    const { links, getProjectFolder } = service(
      { shop: ['api', 'web', 'app'] },
      slugs,
    );
    const both = binding('a', 'app', FRONTEND_ENV, ['frontend', 'backend']);
    const legacy = { ...backend, id: 'legacy', machine: null };
    expect(
      (await links.linksFor([both, legacy], new Set(['a', 'legacy']))).size,
    ).toBe(0);
    expect(getProjectFolder).not.toHaveBeenCalled();
  });
  it('lets a lookup failure propagate instead of deploying without the link', async () => {
    const { links, getProjectFolder } = service(
      { shop: ['api', 'web'] },
      slugs,
    );
    getProjectFolder.mockRejectedValueOnce(new Error('database down'));
    await expect(
      links.linksFor([backend, frontend], new Set(['f'])),
    ).rejects.toThrow('database down');
  });
  it('reads each folder and environment once per call', async () => {
    const { links, getProjectFolder, findProjectEnvironment } = service(
      { shop: ['api', 'web'] },
      slugs,
    );
    await links.linksFor([backend, frontend], new Set(['b', 'f']));
    expect(getProjectFolder).toHaveBeenCalledTimes(2);
    expect(findProjectEnvironment).toHaveBeenCalledTimes(2);
  });
});
