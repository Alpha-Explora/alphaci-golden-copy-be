-- Every workspace is a team; personal workspaces no longer exist.
--
-- A workspace IS a team, and a project only ever lives in one. Personal
-- workspaces broke that: `getMyWorkspaces` lazily created one for any caller
-- who belonged to no team, and project creation outside a group silently fell
-- back to the caller's oldest workspace — reliably that personal one. Projects
-- created that way were invisible to every teammate, which is the bug this
-- closes.
--
-- Structural only: existing personal workspaces are CONVERTED, never deleted.
-- `workspace_id` is referenced by projects, audit events, notifications and the
-- hierarchy tables, so deleting one would cascade into all of them. Merging a
-- converted workspace into another team is a product decision left to the UI.

-- 1. Existing personal workspaces become teams. Membership rows already exist
--    (the owner was inserted as `admin` at creation), so nothing else moves and
--    every project stays exactly where it is.
UPDATE orgs.workspaces
SET kind = 'team',
    updated_at = NOW()
WHERE kind = 'personal';

-- 2. The column default was 'personal', so any INSERT that omitted `kind` —
--    including future ones — minted a personal workspace. Flip it before the
--    CHECK narrows, or such an insert fails instead of being corrected.
ALTER TABLE orgs.workspaces
  ALTER COLUMN kind SET DEFAULT 'team';

-- 3. The ratchet. With 'personal' out of the CHECK, the concept cannot come
--    back by way of a stray insert or a future migration that forgets.
ALTER TABLE orgs.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_kind_check;

ALTER TABLE orgs.workspaces
  ADD CONSTRAINT workspaces_kind_check CHECK (kind IN ('team'));

-- 4. "One personal workspace per owner" is now unsatisfiable by construction,
--    and the ON CONFLICT clause it existed to serve is gone with
--    createPersonalWorkspace(). A user may own several teams.
DROP INDEX IF EXISTS orgs.uq_workspaces_personal_owner;
