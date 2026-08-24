import { ProviderConnectionsController } from './provider-connections.controller';
import type { ProviderConnectionsService } from './provider-connections.service';

describe('ProviderConnectionsController', () => {
  const makeService = () =>
    ({
      listProviderConnections: jest.fn().mockResolvedValue([{ id: 'conn-1' }]),
      createProviderConnection: jest.fn().mockResolvedValue({ id: 'conn-2' }),
      revokeProviderConnection: jest.fn().mockResolvedValue({ revoked: true }),
    }) as unknown as jest.Mocked<ProviderConnectionsService>;

  const request = { session: { user: { id: 'user-1' } } } as never;

  it('lists provider connections for the current user', async () => {
    const service = makeService();
    const controller = new ProviderConnectionsController(service);

    await expect(controller.list(request)).resolves.toEqual([{ id: 'conn-1' }]);
    expect(service.listProviderConnections).toHaveBeenCalledWith('user-1');
  });

  it('creates a provider connection for the current user', async () => {
    const service = makeService();
    const controller = new ProviderConnectionsController(service);
    const body = {
      provider: 'render',
      label: 'Render test',
      token: 'rnd_secret',
    } as never;

    await expect(controller.create(request, body)).resolves.toEqual({
      id: 'conn-2',
    });
    expect(service.createProviderConnection).toHaveBeenCalledWith(
      'user-1',
      body,
    );
  });

  it('revokes a provider connection for the current user', async () => {
    const service = makeService();
    const controller = new ProviderConnectionsController(service);

    await expect(controller.revoke(request, 'conn-1')).resolves.toEqual({
      revoked: true,
    });
    expect(service.revokeProviderConnection).toHaveBeenCalledWith(
      'conn-1',
      'user-1',
    );
  });
});
