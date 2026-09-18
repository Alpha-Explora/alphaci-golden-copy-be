import { OpenRegistrationAdmissionPolicy } from './open-registration.policy.js';

describe('OpenRegistrationAdmissionPolicy', () => {
  it('always admits without an internal stamp', async () => {
    const policy = new OpenRegistrationAdmissionPolicy();

    await expect(
      policy.evaluate(
        { githubUserId: '12345', login: 'octocat' },
        'provider-token',
      ),
    ).resolves.toEqual({ kind: 'admit', isInternal: null });
  });
});
