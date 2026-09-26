-- A deleted project takes its hierarchy repository row with it.
--
-- `hierarchy.repositories.provisioned_project_id` was ON DELETE SET NULL, so
-- every project deleted in AlphaCI (from the dashboard, a GitHub
-- repository.deleted webhook, the deleted-repo sweep, or a provisioning
-- rollback) left its repository row behind with no project. Those ghosts kept
-- showing in the team's project tree as projects nobody could open. Production
-- had 27 of them against 13 live projects, with no assignments or
-- configuration changes on any of them.
--
-- Every repository row is written with a project (ensureLink, the hierarchy
-- "create repository" flow and the 2026-08-24 backfill all set it), so a row
-- whose project is gone has nothing left to represent.
--
-- 1. Remove the existing ghosts, then any delivery project and system that
--    removing them left empty. A project a lead created empty never held a
--    ghost, so it is never touched.
-- 2. Make the link ON DELETE CASCADE so deleting a project can no longer leave
--    a ghost. Assignments and configuration history hang off the repository
--    row and go with it, as they only describe the deleted project.
--    A project folder emptied by a later deletion is kept, like one emptied by
--    a move: leads archive it from the team page.
--
-- Idempotent and cold-replay safe: on an empty database step 1 matches
-- nothing, and step 2 re-creates the constraint under the same name.

DO $$
DECLARE
  ghost_delivery_ids UUID[];
  emptied_system_ids UUID[];
  ghost_count        INT;
  delivery_count     INT;
  system_count       INT;
BEGIN
  WITH removed AS (
    DELETE FROM hierarchy.repositories
     WHERE provisioned_project_id IS NULL
    RETURNING delivery_project_id
  )
  SELECT array_agg(DISTINCT delivery_project_id), count(*)
    INTO ghost_delivery_ids, ghost_count
    FROM removed;

  -- A separate statement from the delete above, so NOT EXISTS sees the rows
  -- it removed as gone.
  WITH removed AS (
    DELETE FROM hierarchy.delivery_projects dp
     WHERE dp.id = ANY(COALESCE(ghost_delivery_ids, '{}'))
       AND NOT EXISTS (SELECT 1 FROM hierarchy.repositories r
                       WHERE r.delivery_project_id = dp.id)
    RETURNING system_id
  )
  SELECT array_agg(DISTINCT system_id), count(*)
    INTO emptied_system_ids, delivery_count
    FROM removed;

  DELETE FROM hierarchy.systems s
   WHERE s.id = ANY(COALESCE(emptied_system_ids, '{}'))
     AND NOT EXISTS (SELECT 1 FROM hierarchy.delivery_projects dp
                     WHERE dp.system_id = s.id);
  GET DIAGNOSTICS system_count = ROW_COUNT;

  RAISE NOTICE 'Removed % ghost repositor(y/ies), % emptied delivery project(s), % emptied system(s)',
    ghost_count, delivery_count, system_count;
END $$;

ALTER TABLE hierarchy.repositories
  DROP CONSTRAINT IF EXISTS repositories_provisioned_project_id_fkey;

ALTER TABLE hierarchy.repositories
  ADD CONSTRAINT repositories_provisioned_project_id_fkey
  FOREIGN KEY (provisioned_project_id)
  REFERENCES projects.provisioned_projects(id)
  ON DELETE CASCADE;
