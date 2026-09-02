import type { DatabaseService } from '#kernel/db/database.service.js';
import { OAuthStateRepository } from './oauth-state.repository.js';

const makeDatabaseService = (rows: unknown[] = [], rowCount = 1) =>
  ({
    query: jest.fn().mockResolvedValue({ rows, rowCount }),
  }) as unknown as DatabaseService;

describe('OAuthStateRepository', () => {
  it('saves OAuth state in the identity schema', async () => {
    const db = makeDatabaseService();
    const repo = new OAuthStateRepository(db);

    await repo.save('state-1', '/projects', 'github');

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO identity.oauth_states'),
      ['state-1', '/projects', 'github'],
    );
  });

  it('deletes OAuth state from the identity schema', async () => {
    const db = makeDatabaseService([
      { return_to: '/projects', provider: 'github' },
    ]);
    const repo = new OAuthStateRepository(db);

    const result = await repo.findAndDelete('state-1');

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM identity.oauth_states'),
      ['state-1'],
    );
    expect(result).toEqual({ returnTo: '/projects', provider: 'github' });
  });

  it('prunes expired OAuth state through the identity schema function', async () => {
    const db = makeDatabaseService();
    const repo = new OAuthStateRepository(db);

    await repo.pruneExpired();

    expect(db.query).toHaveBeenCalledWith(
      'SELECT identity.clean_expired_oauth_states();',
      [],
    );
  });
});
