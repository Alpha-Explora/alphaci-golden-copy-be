import {
  AdminGrantError,
  githubLoginProblem,
  grantSuperAdmin,
  type SqlRunner,
} from './admin-grant';

const SIGN_IN = 'https://alphaci.example.com';

interface Call {
  text: string;
  values: readonly unknown[] | undefined;
}

/** A SqlRunner that answers each query by matching a fragment of its SQL. */
function fakeDb(
  answers: Array<{ match: string; rows: Record<string, unknown>[] }>,
): {
  runner: SqlRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const runner: SqlRunner = {
    query: async <Row extends Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) => {
      calls.push({ text, values });
      const answer = answers.find((candidate) =>
        text.includes(candidate.match),
      );
      return { rows: (answer?.rows ?? []) as Row[] };
    },
  };
  return { runner, calls };
}

describe('githubLoginProblem', () => {
  it.each(['lloydlim1', 'a', 'Mixed-Case-9', 'x'.repeat(39)])(
    'accepts %s',
    (login) => {
      expect(githubLoginProblem(login)).toBeUndefined();
    },
  );

  it.each([
    '@lloydlim1',
    'https://github.com/x',
    'has space',
    '-leading',
    'trailing-',
    'a--b',
    'x'.repeat(40),
  ])('rejects %j', (login) => {
    expect(githubLoginProblem(login)).toEqual(expect.any(String));
  });
});

describe('grantSuperAdmin', () => {
  it('upserts a super_admin row for an existing user, matching login case-insensitively', async () => {
    const { runner, calls } = fakeDb([
      {
        match: 'FROM identity.app_users',
        rows: [{ id: 'user-1', login: 'LloydLim1', archived_at: null }],
      },
      { match: 'FROM identity.platform_admins', rows: [] },
    ]);

    const result = await grantSuperAdmin(runner, 'lloydlim1', SIGN_IN);

    expect(result).toEqual({
      userId: 'user-1',
      login: 'LloydLim1',
      previousRole: null,
    });
    expect(calls[0]?.text).toContain('LOWER(login) = LOWER($1)');
    expect(calls[0]?.values).toEqual(['lloydlim1']);
    const insert = calls.find((call) =>
      call.text.includes('INSERT INTO identity.platform_admins'),
    );
    expect(insert?.text).toContain("'super_admin', NULL");
    expect(insert?.values).toEqual(['user-1']);
  });

  it('reports the role it replaces', async () => {
    const { runner } = fakeDb([
      {
        match: 'FROM identity.app_users',
        rows: [{ id: 'u', login: 'ann', archived_at: null }],
      },
      { match: 'FROM identity.platform_admins', rows: [{ role: 'admin' }] },
    ]);

    await expect(
      grantSuperAdmin(runner, 'ann', SIGN_IN),
    ).resolves.toMatchObject({
      previousRole: 'admin',
    });
  });

  it('asks the operator to sign in first when the user does not exist yet', async () => {
    const { runner, calls } = fakeDb([
      { match: 'FROM identity.app_users', rows: [] },
    ]);

    const error = await grantSuperAdmin(runner, 'newcomer', SIGN_IN).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AdminGrantError);
    expect((error as Error).message).toBe(
      'No AlphaCI user has the GitHub login "newcomer" yet. Ask them to sign in once at https://alphaci.example.com, then run this command again.',
    );
    expect(calls.some((call) => call.text.includes('INSERT'))).toBe(false);
  });

  it('refuses an archived account and writes nothing', async () => {
    const { runner, calls } = fakeDb([
      {
        match: 'FROM identity.app_users',
        rows: [{ id: 'u', login: 'gone', archived_at: '2026-01-01T00:00:00Z' }],
      },
    ]);

    await expect(grantSuperAdmin(runner, 'gone', SIGN_IN)).rejects.toThrow(
      /is archived/,
    );
    expect(calls.some((call) => call.text.includes('INSERT'))).toBe(false);
  });

  it('refuses when two accounts match the login', async () => {
    const { runner } = fakeDb([
      {
        match: 'FROM identity.app_users',
        rows: [
          { id: 'a', login: 'dup', archived_at: null },
          { id: 'b', login: 'DUP', archived_at: null },
        ],
      },
    ]);

    await expect(grantSuperAdmin(runner, 'dup', SIGN_IN)).rejects.toThrow(
      /More than one/,
    );
  });

  it('validates the login before querying', async () => {
    const { runner, calls } = fakeDb([]);

    await expect(grantSuperAdmin(runner, '@nope', SIGN_IN)).rejects.toThrow(
      AdminGrantError,
    );
    expect(calls).toHaveLength(0);
  });
});
