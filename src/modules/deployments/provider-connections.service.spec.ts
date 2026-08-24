import { ProviderConnectionsService } from './provider-connections.service';

describe('ProviderConnectionsService', () => {
  const repository = {
    createProviderConnection: jest.fn(),
    listProviderConnections: jest.fn(),
    revokeProviderConnection: jest.fn(),
  };
  const encryptionService = {
    encrypt: jest.fn(),
  };
  const vercelClient = {
    validateConnection: jest.fn(),
    validateTeamAccess: jest.fn(),
  };
  const clientRegistry = {
    getClient: jest.fn(),
  };
  const workspacesService = {
    getMyWorkspaces: jest.fn(),
  };

  let service: ProviderConnectionsService;

  beforeEach(() => {
    jest.clearAllMocks();
    encryptionService.encrypt.mockReturnValue('encrypted-token');
    vercelClient.validateConnection.mockResolvedValue({
      id: 'user_123',
      name: 'Vercel User',
      metadata: { orgId: 'user_123' },
    });
    vercelClient.validateTeamAccess.mockResolvedValue({
      id: 'team_123',
      slug: 'flowci',
    });
    clientRegistry.getClient.mockReturnValue(vercelClient);
    workspacesService.getMyWorkspaces.mockResolvedValue({
      enabled: true,
      items: [
        {
          id: 'workspace-1',
          name: 'Personal workspace',
          kind: 'personal',
          role: 'admin',
        },
      ],
    });
    repository.createProviderConnection.mockResolvedValue({
      id: 'connection-1',
      provider: 'vercel',
      label: 'Team Vercel',
      tokenLastFour: 'cdef',
      status: 'active',
      metadata: {
        accountType: 'team',
        orgId: 'team_123',
        teamId: 'team_123',
        teamSlug: 'flowci',
      },
      createdAt: '2026-06-10T00:00:00.000Z',
      updatedAt: '2026-06-10T00:00:00.000Z',
      lastUsedAt: null,
    });

    service = new ProviderConnectionsService(
      repository as never,
      encryptionService as never,
      clientRegistry as never,
      workspacesService as never,
    );
  });

  it('validates Vercel team access before saving team connection metadata', async () => {
    await service.createProviderConnection('user-1', {
      provider: 'vercel',
      label: 'Team Vercel',
      token: 'vercel-token-cdef',
      vercelTeamId: 'team_123',
    });

    expect(vercelClient.validateTeamAccess).toHaveBeenCalledWith(
      'vercel-token-cdef',
      'team_123',
    );
    expect(repository.createProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          accountType: 'team',
          orgId: 'team_123',
          teamId: 'team_123',
          teamSlug: 'flowci',
        }),
      }),
    );
  });

  it('does not save a Vercel team connection when team validation fails', async () => {
    vercelClient.validateTeamAccess.mockRejectedValueOnce(
      new Error('Vercel team access validation failed: 403'),
    );

    await expect(
      service.createProviderConnection('user-1', {
        provider: 'vercel',
        label: 'Team Vercel',
        token: 'vercel-token-cdef',
        vercelTeamId: 'team_123',
      }),
    ).rejects.toThrow('Vercel team access validation failed');

    expect(repository.createProviderConnection).not.toHaveBeenCalled();
  });

  it('rejects provider mutations for users without admin or delegated_lead workspace access', async () => {
    workspacesService.getMyWorkspaces.mockResolvedValueOnce({
      enabled: true,
      items: [
        {
          id: 'workspace-1',
          name: 'Team workspace',
          kind: 'team',
          role: 'viewer',
        },
      ],
    });

    await expect(
      service.createProviderConnection('user-1', {
        provider: 'vercel',
        label: 'Team Vercel',
        token: 'vercel-token-cdef',
      }),
    ).rejects.toThrow(
      'Provider connection management requires admin or delegated_lead workspace access',
    );

    expect(repository.createProviderConnection).not.toHaveBeenCalled();
  });

  it('checks workspace role before revoking provider connections', async () => {
    repository.revokeProviderConnection.mockResolvedValueOnce(true);

    await expect(
      service.revokeProviderConnection('connection-1', 'user-1'),
    ).resolves.toEqual({ revoked: true });

    expect(workspacesService.getMyWorkspaces).toHaveBeenCalledWith('user-1');
    expect(repository.revokeProviderConnection).toHaveBeenCalledWith(
      'connection-1',
      'user-1',
    );
  });
});
