import { Test } from '@nestjs/testing';

import {
  SESSION_USER_LOOKUP,
  type SessionUserLookup,
} from '#kernel/auth/session-user-lookup.contract';
import { DatabaseService } from '#kernel/db/database.service';
import { AuthIdentityModule } from './auth-identity.module';

/**
 * Compiles the real module so the SESSION_USER_LOOKUP alias is resolved the
 * way the app resolves it. Specs that inject the token with a mock cannot see
 * an alias that points at a class without the contract's method, which is how
 * every GitHub access grant crashed in production while all tests passed.
 */
describe('AuthIdentityModule', () => {
  it('resolves SESSION_USER_LOOKUP to a provider that implements findSessionUser', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [
        {
          id: 'user-1',
          login: 'dev-one',
          display_name: null,
          email: null,
          avatar_url: null,
          onboarding_completed_at: null,
          is_internal: false,
        },
      ],
    });
    const module = await Test.createTestingModule({
      imports: [AuthIdentityModule],
    })
      .overrideProvider(DatabaseService)
      .useValue({ query })
      .compile();

    const lookup = module.get<SessionUserLookup>(SESSION_USER_LOOKUP);

    expect(typeof lookup.findSessionUser).toBe('function');
    await expect(lookup.findSessionUser('user-1')).resolves.toEqual(
      expect.objectContaining({ id: 'user-1', login: 'dev-one' }),
    );
    expect(query).toHaveBeenCalledWith(expect.any(String), ['user-1']);
  });
});
