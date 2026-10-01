import { ConflictException } from '@nestjs/common';

export const PROJECT_NAME_TAKEN = 'PROJECT_NAME_TAKEN';

/** 409 raised when a team already has a non-archived Project with this name. */
export class ProjectNameTakenException extends ConflictException {
  constructor(name: string) {
    super({
      code: PROJECT_NAME_TAKEN,
      message: `A Project named "${name}" already exists in this team.`,
    });
  }
}

/**
 * SQL for the uniqueness rule shared by every Project-creating path: same
 * team, non-archived, case-insensitive, trimmed. $1 = group id, $2 = name.
 */
export const ACTIVE_PROJECT_NAME_EXISTS_SQL = `
  SELECT 1 FROM hierarchy.delivery_projects
  WHERE group_id = $1
    AND status <> 'archived'
    AND lower(btrim(name)) = lower(btrim($2))
  LIMIT 1;
`;

/**
 * Advisory-lock key text for (team, name). No unique index backs the rule
 * (no migration), so creators of the same name serialize on this lock and
 * re-check inside it. Usage: pg_advisory_[xact_]lock(hashtextextended($1, 0)).
 */
export function projectNameLockKey(groupId: string, name: string): string {
  return `delivery_project_name:${groupId}:${name.trim().toLowerCase()}`;
}
