-- Down: restore 'personal' as a permitted workspace kind.
--
-- This reopens the constraint and the default. It deliberately does NOT convert
-- any workspace back to 'personal': the up migration does not record which rows
-- it converted, so guessing would demote teams that were always teams. Restore
-- individual rows by id if a specific one has to go back.

ALTER TABLE orgs.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_kind_check;

ALTER TABLE orgs.workspaces
  ADD CONSTRAINT workspaces_kind_check CHECK (kind IN ('personal', 'team'));

ALTER TABLE orgs.workspaces
  ALTER COLUMN kind SET DEFAULT 'personal';

CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_personal_owner
  ON orgs.workspaces(owner_user_id)
  WHERE kind = 'personal';
