import { Test } from '@nestjs/testing';

import { DatabaseService } from '#kernel/db/database.service';
import { ProviderConnectionsRepository } from '../infrastructure/provider-connections.repository';

const row = {
  id: 'connection-1',
  provider: 'render',
  label: 'Render main',
  token_last_four: 'cret',
  status: 'active',
  created_at: '2026-06-08T00:00:00.000Z',
  updated_at: '2026-06-08T00:00:00.000Z',
  last_used_at: null,
};

describe('ProviderConnectionsRepository', () => {
  it('stores only encrypted provider tokens', async () => {
    const database = {
      query: jest.fn().mockResolvedValue({ rows: [row] }),
    } as unknown as DatabaseService;
    const module = await Test.createTestingModule({
      providers: [
        ProviderConnectionsRepository,
        { provide: DatabaseService, useValue: database },
      ],
    }).compile();

    const repository = module.get(ProviderConnectionsRepository);
    await repository.createProviderConnection({
      userId: 'user-1',
      provider: 'render',
      label: 'Render main',
      encryptedToken: 'encrypted-token',
      tokenLastFour: 'cret',
    });

    const call = (
      database.query as jest.MockedFunction<DatabaseService['query']>
    ).mock.calls[0];
    const queryText = String(call?.[0] ?? '');
    const queryValues = call?.[1] ?? [];
    expect(queryText).toContain(
      'INSERT INTO env_provisioning.provider_connections',
    );
    expect(queryText).toContain('encrypted_token');
    expect(queryValues).toContain('encrypted-token');
    expect(queryValues).not.toContain('plain-token');
  });
});
