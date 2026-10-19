import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { SqlRunner } from './admin-grant';

/**
 * A one-time host enrollment, made from the server itself so the AlphaCI
 * server can enroll its own on-prem agent without a browser: the same row the
 * Hosts page creates (`onprem_enrollments`, code stored as its SHA-256), for a
 * team and on behalf of a user who has signed in once.
 */
export class HostEnrollmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostEnrollmentError';
  }
}

export async function createHostEnrollment(
  db: SqlRunner,
  input: { team: string; githubLogin: string; name: string },
): Promise<{ code: string; team: string }> {
  const users = await db.query<{ id: string }>(
    'SELECT id FROM identity.app_users WHERE LOWER(login) = LOWER($1) AND archived_at IS NULL LIMIT 1',
    [input.githubLogin],
  );
  const user = users.rows[0];
  if (!user)
    throw new HostEnrollmentError(
      `No AlphaCI user has the GitHub login "${input.githubLogin}". Sign in once, then run this again.`,
    );
  const teams = await db.query<{ id: string; name: string }>(
    'SELECT id, name FROM orgs.workspaces WHERE id::text = $1 OR LOWER(name) = LOWER($1) LIMIT 2',
    [input.team],
  );
  if (teams.rows.length !== 1)
    throw new HostEnrollmentError(
      teams.rows.length
        ? `More than one team is named "${input.team}". Use the team ID instead.`
        : `No team is named "${input.team}".`,
    );
  const team = teams.rows[0]!;
  const code = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO env_provisioning.onprem_enrollments(workspace_id, created_by, name, platform, request_id, replaces_machine_id, code_sha256)
     VALUES ($1, $2, $3, 'ubuntu', $4, NULL, $5)`,
    [
      team.id,
      user.id,
      input.name,
      randomUUID(),
      createHash('sha256').update(code).digest('hex'),
    ],
  );
  return { code, team: team.name };
}
