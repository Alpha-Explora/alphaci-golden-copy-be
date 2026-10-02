import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { CustomDomainsService } from './custom-domains.service';

const TARGET = {
  id: 'target-1',
  provider: 'vercel' as const,
  providerProjectId: 'prj_1',
};

const DOMAIN = {
  id: 'domain-1',
  projectId: 'project-1',
  deploymentTargetId: 'target-1',
  provider: 'vercel' as const,
  hostname: 'app.example.com',
  apexDomain: 'example.com',
  gitBranch: null,
  verified: false,
  verification: [
    { type: 'TXT', domain: '_vercel.example.com', value: 'abc', reason: 'ns' },
  ],
  misconfigured: null,
  lastCheckedAt: null,
  lastErrorSafeMessage: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
};

function build(
  overrides: {
    client?: Record<string, unknown>;
    domain?: unknown;
    role?: string;
    visible?: boolean;
  } = {},
) {
  const client = {
    addDomain: jest.fn(() =>
      Promise.resolve({
        hostname: 'app.example.com',
        apexDomain: 'example.com',
        verified: false,
        verification: DOMAIN.verification,
        misconfigured: null,
      }),
    ),
    verifyDomain: jest.fn(() =>
      Promise.resolve({
        hostname: 'app.example.com',
        apexDomain: 'example.com',
        verified: true,
        verification: [],
        misconfigured: false,
      }),
    ),
    removeDomain: jest.fn(() => Promise.resolve({ removed: true })),
    ...overrides.client,
  };

  const repository = {
    listForProject: jest.fn(() => Promise.resolve([DOMAIN])),
    findById: jest.fn(() =>
      Promise.resolve('domain' in overrides ? overrides.domain : DOMAIN),
    ),
    insert: jest.fn((input: unknown) =>
      Promise.resolve({ ...DOMAIN, ...(input as object) }),
    ),
    updateState: jest.fn((input: { id: string }) =>
      Promise.resolve({ ...DOMAIN, ...input }),
    ),
    deleteById: jest.fn(() => Promise.resolve(true)),
  };

  const deploymentTargetsService = {
    providerContextForTarget: jest.fn(() =>
      Promise.resolve({ target: TARGET, token: 'vc_token', scope: {} }),
    ),
  };
  const clientRegistry = { getClient: jest.fn(() => client) };
  const projectReferenceLookup = {
    findProjectReference: jest.fn(() =>
      Promise.resolve(
        overrides.visible === false ? null : { projectId: 'project-1' },
      ),
    ),
  };
  const appRoleLookup = {
    findAppRole: jest.fn(() => Promise.resolve(overrides.role ?? 'admin')),
  };
  const auditEventsService = { recordProjectEvent: jest.fn() };

  const service = new CustomDomainsService(
    repository as never,
    deploymentTargetsService as never,
    clientRegistry as never,
    projectReferenceLookup as never,
    appRoleLookup as never,
    auditEventsService as never,
  );

  return {
    service,
    client,
    repository,
    deploymentTargetsService,
    projectReferenceLookup,
    appRoleLookup,
    auditEventsService,
  };
}

describe('CustomDomainsService', () => {
  describe('addDomain', () => {
    it('attaches the hostname and stores the provider verification verbatim', async () => {
      const { service, client, repository } = build();

      const domain = await service.addDomain('project-1', 'user-1', {
        deploymentTargetId: 'target-1',
        hostname: 'app.example.com',
      });

      expect(client.addDomain).toHaveBeenCalledWith(
        expect.objectContaining({
          targetId: 'prj_1',
          hostname: 'app.example.com',
          gitBranch: null,
        }),
      );
      // Stored exactly as returned: these are the DNS records the reader has
      // to create, so reshaping them would be inventing instructions.
      expect(repository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ verification: DOMAIN.verification }),
      );
      expect(domain.hostname).toBe('app.example.com');
    });

    it('pins the hostname to a branch when one is given', async () => {
      const { service, client } = build();

      await service.addDomain('project-1', 'user-1', {
        deploymentTargetId: 'target-1',
        hostname: 'staging.example.com',
        gitBranch: 'feat/checkout',
      });

      expect(client.addDomain).toHaveBeenCalledWith(
        expect.objectContaining({ gitBranch: 'feat/checkout' }),
      );
    });

    it.each([
      ['a URL rather than a hostname', 'https://app.example.com/path'],
      ['a bare label with no dot', 'localhost'],
      ['an empty value', '   '],
      ['a leading hyphen', '-app.example.com'],
    ])(
      'rejects %s before spending a provider call',
      async (_label, hostname) => {
        const { service, client } = build();

        await expect(
          service.addDomain('project-1', 'user-1', {
            deploymentTargetId: 'target-1',
            hostname,
          }),
        ).rejects.toThrow(BadRequestException);
        expect(client.addDomain).not.toHaveBeenCalled();
      },
    );

    it('normalizes case and a trailing dot', async () => {
      const { service, client } = build();

      await service.addDomain('project-1', 'user-1', {
        deploymentTargetId: 'target-1',
        hostname: '  APP.Example.COM.  ',
      });

      expect(client.addDomain).toHaveBeenCalledWith(
        expect.objectContaining({ hostname: 'app.example.com' }),
      );
    });

    /* A domain already on another Vercel project needs a different action from
     * a malformed one -- remove it there, versus pick another name -- so it must
     * not collapse into a generic 400. */
    it('reports an already-assigned domain as a conflict', async () => {
      const { service } = build({
        client: {
          addDomain: jest.fn(() =>
            Promise.reject(
              new Error(
                'app.example.com is already assigned to a Vercel project.',
              ),
            ),
          ),
        },
      });

      await expect(
        service.addDomain('project-1', 'user-1', {
          deploymentTargetId: 'target-1',
          hostname: 'app.example.com',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('reports a provider with no domain support as unavailable', async () => {
      const { service } = build({ client: { addDomain: undefined } });

      await expect(
        service.addDomain('project-1', 'user-1', {
          deploymentTargetId: 'target-1',
          hostname: 'app.example.com',
        }),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('refuses lead and qa with HOSTING_LEAD_ONLY before touching the provider', async () => {
      for (const role of ['lead', 'qa']) {
        const { service, deploymentTargetsService, repository } = build({
          role,
        });
        const err = await service
          .addDomain('project-1', 'user-1', {
            deploymentTargetId: 'target-1',
            hostname: 'app.example.com',
          })
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toMatchObject({
          code: 'HOSTING_LEAD_ONLY',
        });
        expect(
          deploymentTargetsService.providerContextForTarget,
        ).not.toHaveBeenCalled();
        expect(repository.insert).not.toHaveBeenCalled();
      }
    });

    it('allows admin and member (Developer)', async () => {
      for (const role of ['admin', 'member']) {
        const { service } = build({ role });
        await expect(
          service.addDomain('project-1', 'user-1', {
            deploymentTargetId: 'target-1',
            hostname: 'app.example.com',
          }),
        ).resolves.toBeDefined();
      }
    });

    it('answers 404 for an invisible project, before the role check', async () => {
      const { service, appRoleLookup } = build({
        visible: false,
        role: 'member',
      });
      await expect(
        service.addDomain('project-1', 'user-1', {
          deploymentTargetId: 'target-1',
          hostname: 'app.example.com',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(appRoleLookup.findAppRole).not.toHaveBeenCalled();
    });

    it('fails closed when the role cannot be resolved', async () => {
      const { service, appRoleLookup } = build();
      (appRoleLookup.findAppRole as jest.Mock).mockResolvedValueOnce(undefined);
      await expect(
        service.addDomain('project-1', 'user-1', {
          deploymentTargetId: 'target-1',
          hostname: 'app.example.com',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('verifyDomain', () => {
    it('refreshes the stored row from the provider answer', async () => {
      const { service, repository } = build();

      await service.verifyDomain('project-1', 'domain-1', 'user-1');

      expect(repository.updateState).toHaveBeenCalledWith({
        id: 'domain-1',
        verified: true,
        verification: [],
        misconfigured: false,
        lastErrorSafeMessage: null,
      });
    });

    /* A check that could not run is not a domain that is broken. Recording the
     * reason on the row keeps it next to the domain instead of only in a toast
     * that is gone by the time anyone looks. */
    it('records a failed check without flipping the verified state', async () => {
      const { service, repository } = build({
        client: {
          verifyDomain: jest.fn(() =>
            Promise.reject(new Error('rate limited')),
          ),
        },
      });

      await service.verifyDomain('project-1', 'domain-1', 'user-1');

      expect(repository.updateState).toHaveBeenCalledWith(
        expect.objectContaining({
          verified: DOMAIN.verified,
          lastErrorSafeMessage: 'rate limited',
        }),
      );
    });

    it('strips credentials from a recorded provider message', async () => {
      const { service, repository } = build({
        client: {
          verifyDomain: jest.fn(() =>
            Promise.reject(new Error('denied for Bearer vc_supersecret')),
          ),
        },
      });

      await service.verifyDomain('project-1', 'domain-1', 'user-1');

      const recorded = repository.updateState.mock.calls[0]?.[0] as unknown as {
        lastErrorSafeMessage: string;
      };
      expect(recorded.lastErrorSafeMessage).toContain('Bearer [redacted]');
      expect(recorded.lastErrorSafeMessage).not.toContain('vc_supersecret');
    });

    it('refuses a domain belonging to another project', async () => {
      const { service } = build({
        domain: { ...DOMAIN, projectId: 'someone-elses-project' },
      });

      await expect(
        service.verifyDomain('project-1', 'domain-1', 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('removeDomain', () => {
    it('detaches from the provider and deletes the row', async () => {
      const { service, client, repository } = build();

      await expect(
        service.removeDomain('project-1', 'domain-1', 'user-1'),
      ).resolves.toMatchObject({
        removed: true,
        hostname: 'app.example.com',
        providerError: null,
      });
      expect(client.removeDomain).toHaveBeenCalled();
      expect(repository.deleteById).toHaveBeenCalledWith('domain-1');
    });

    /* A provider having a bad moment must not leave a hostname stuck in the UI
     * with no way to remove it. The failure is reported, not swallowed. */
    it('still detaches locally when the provider call fails, and says so', async () => {
      const { service, repository } = build({
        client: {
          removeDomain: jest.fn(() =>
            Promise.reject(new Error('Vercel is down')),
          ),
        },
      });

      const result = await service.removeDomain(
        'project-1',
        'domain-1',
        'user-1',
      );

      expect(result.removed).toBe(true);
      expect(result.providerError).toContain('Vercel is down');
      expect(repository.deleteById).toHaveBeenCalledWith('domain-1');
    });
  });

  describe('access control on verify/remove', () => {
    it('verify: lead is refused, invisible project is 404', async () => {
      await expect(
        build({ role: 'lead' }).service.verifyDomain(
          'project-1',
          'domain-1',
          'user-1',
        ),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        build({ visible: false }).service.verifyDomain(
          'project-1',
          'domain-1',
          'user-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('remove: a stranger (invisible project) gets 404 and nothing is deleted', async () => {
      const { service, repository, deploymentTargetsService } = build({
        visible: false,
        role: 'admin',
      });
      await expect(
        service.removeDomain('project-1', 'domain-1', 'user-1'),
      ).rejects.toThrow(NotFoundException);
      expect(repository.deleteById).not.toHaveBeenCalled();
      expect(
        deploymentTargetsService.providerContextForTarget,
      ).not.toHaveBeenCalled();
    });

    it('remove: lead and qa are refused and nothing is deleted', async () => {
      for (const role of ['lead', 'qa']) {
        const { service, repository } = build({ role });
        await expect(
          service.removeDomain('project-1', 'domain-1', 'user-1'),
        ).rejects.toThrow(ForbiddenException);
        expect(repository.deleteById).not.toHaveBeenCalled();
      }
    });
  });

  describe('listDomains', () => {
    it('allows any user who can see the project, whatever their role', async () => {
      const { service } = build({ role: 'qa' });
      await expect(
        service.listDomains('project-1', 'user-1'),
      ).resolves.toHaveLength(1);
    });

    it('answers 404 for an invisible project', async () => {
      const { service, repository } = build({ visible: false });
      await expect(service.listDomains('project-1', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.listForProject).not.toHaveBeenCalled();
    });
  });
});
