-- Rollback: 20261008010000_delivery_project_members
-- Drops the Project membership table.
--
-- Destroys the record of who was added to which Project. It does NOT revoke
-- GitHub access: the per-repository grants live in
-- hierarchy.repository_assignments and stay until revoked there. Revoke the
-- developers' assignments first if the access must go with the memberships.
BEGIN;
DROP TABLE IF EXISTS hierarchy.delivery_project_members;
COMMIT;
