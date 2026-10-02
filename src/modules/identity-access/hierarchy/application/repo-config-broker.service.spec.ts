import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { RepoConfigBrokerService } from './repo-config-broker.service';

function build(options: { role?: string | undefined; visible?: boolean } = {}) {
  const repository = {
    id: 'repo-1',
    groupId: 'group-1',
    repoFullName: 'acme/api',
  };
  const accessService = {
    assertRepositoryVisible: jest.fn(() =>
      options.visible === false
        ? Promise.reject(new NotFoundException('Repository not found'))
        : Promise.resolve({ repository, viaManager: false }),
    ),
  };
  const changesRepository = {
    record: jest.fn(() => Promise.resolve()),
    listCurrentNames: jest.fn(() => Promise.resolve([])),
  };
  const secretsProvider = {
    resolveInstallationToken: jest.fn(() => Promise.resolve('inst-token')),
    writeVariable: jest.fn(() => Promise.resolve()),
    writeSecret: jest.fn(() => Promise.resolve()),
    deleteVariable: jest.fn(() => Promise.resolve()),
    deleteSecret: jest.fn(() => Promise.resolve()),
  };
  const auditEventsService = { recordProjectEvent: jest.fn() };
  const appRoleLookup = {
    findAppRole: jest.fn(() =>
      Promise.resolve('role' in options ? options.role : 'member'),
    ),
  };
  const service = new RepoConfigBrokerService(
    {} as never,
    accessService as never,
    changesRepository as never,
    secretsProvider as never,
    auditEventsService as never,
    appRoleLookup as never,
  );
  return { service, accessService, secretsProvider, appRoleLookup };
}

describe('RepoConfigBrokerService role gate', () => {
  it.each(['admin', 'member'])(
    'lets %s write a variable and a secret',
    async (role) => {
      const { service, secretsProvider } = build({ role });
      await service.writeVariable('repo-1', 'u', 'FOO', 'v', 'non_production');
      await service.writeSecret('repo-1', 'u', 'BAR', 'v', 'non_production');
      expect(secretsProvider.writeVariable).toHaveBeenCalled();
      expect(secretsProvider.writeSecret).toHaveBeenCalled();
    },
  );

  it.each(['lead', 'qa'])(
    '%s (even an assignee) gets ENV_VARS_LEAD_ONLY on write and delete, no GitHub call',
    async (role) => {
      const { service, secretsProvider } = build({ role });
      for (const attempt of [
        () =>
          service.writeVariable('repo-1', 'u', 'FOO', 'v', 'non_production'),
        () => service.writeSecret('repo-1', 'u', 'BAR', 'v', 'non_production'),
        () => service.deleteConfiguration('repo-1', 'u', 'secret', 'BAR'),
      ]) {
        const error = await attempt().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toMatchObject({
          code: 'ENV_VARS_LEAD_ONLY',
        });
      }
      expect(secretsProvider.resolveInstallationToken).not.toHaveBeenCalled();
      expect(secretsProvider.writeVariable).not.toHaveBeenCalled();
      expect(secretsProvider.deleteSecret).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the role cannot be resolved', async () => {
    const { service } = build({ role: undefined });
    await expect(
      service.writeSecret('repo-1', 'u', 'BAR', 'v', 'non_production'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('answers 404 (not swallowed) before the role check when the repository is not visible', async () => {
    const { service, appRoleLookup } = build({ role: 'admin', visible: false });
    await expect(
      service.writeSecret('repo-1', 'u', 'BAR', 'v', 'non_production'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(appRoleLookup.findAppRole).not.toHaveBeenCalled();
  });

  it('still hard-blocks production scope for an allowed role', async () => {
    const { service } = build({ role: 'admin' });
    await expect(
      service.writeSecret('repo-1', 'u', 'BAR', 'v', 'production'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('keeps listing open to anyone who can see the repository', async () => {
    const { service, appRoleLookup } = build({ role: 'qa' });
    await expect(service.listConfiguration('repo-1', 'u')).resolves.toEqual({
      variables: [],
      secrets: [],
    });
    expect(appRoleLookup.findAppRole).not.toHaveBeenCalled();
  });
});
