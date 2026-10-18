/**
 * Grants the platform super-admin role to an existing AlphaCI user.
 *
 * Writes identity.platform_admins directly, as the migration's bootstrap does.
 * A user is found by GitHub login, so the operator never needs the internal
 * user id. The user must have signed in once, because that is what creates
 * identity.app_users. A pending grant applied at first login is not built:
 * it would touch the sign-in path for a one-time setup step.
 */

export interface SqlRunner {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
}

export interface AdminGrantResult {
  readonly userId: string;
  readonly login: string;
  /** The role the user held before this run, or null for an ordinary user. */
  readonly previousRole: string | null;
}

export class AdminGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminGrantError';
  }
}

/** A GitHub username: 1 to 39 characters, letters, digits and single hyphens, no leading or trailing hyphen. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** Why a value is not a GitHub login, or undefined when it is one. */
export function githubLoginProblem(login: string): string | undefined {
  if (!GITHUB_LOGIN.test(login)) {
    return `"${login}" is not a GitHub login. Use the username only, without @ or a URL.`;
  }
  return undefined;
}

export async function grantSuperAdmin(
  db: SqlRunner,
  login: string,
  signInUrl: string,
): Promise<AdminGrantResult> {
  const problem = githubLoginProblem(login);
  if (problem !== undefined) throw new AdminGrantError(problem);

  const users = await db.query<{
    id: string;
    login: string;
    archived_at: string | null;
  }>(
    `SELECT id, login, archived_at
       FROM identity.app_users
      WHERE LOWER(login) = LOWER($1)
      LIMIT 2`,
    [login],
  );
  if (users.rows.length === 0) {
    throw new AdminGrantError(
      `No AlphaCI user has the GitHub login "${login}" yet. Ask them to sign in once at ${signInUrl}, then run this command again.`,
    );
  }
  if (users.rows.length > 1) {
    throw new AdminGrantError(
      `More than one AlphaCI user matches "${login}". Resolve the duplicate in the database first.`,
    );
  }
  const user = users.rows[0];
  if (!user)
    throw new AdminGrantError(
      `No AlphaCI user has the GitHub login "${login}" yet.`,
    );
  if (user.archived_at !== null) {
    throw new AdminGrantError(
      `The account "${user.login}" is archived. Restore it before granting a role.`,
    );
  }

  const previous = await db.query<{ role: string }>(
    `SELECT role FROM identity.platform_admins WHERE user_id = $1 LIMIT 1`,
    [user.id],
  );
  const previousRole = previous.rows[0]?.role ?? null;

  // granted_by stays NULL: the grant comes from the operator's shell, not from
  // a signed-in user. The column is nullable, so the audit trail is still
  // explicit about it.
  await db.query(
    `INSERT INTO identity.platform_admins (user_id, role, granted_by)
     VALUES ($1, 'super_admin', NULL)
     ON CONFLICT (user_id)
     DO UPDATE SET role = 'super_admin', granted_by = NULL, granted_at = NOW()`,
    [user.id],
  );

  return { userId: user.id, login: user.login, previousRole };
}
