-- Down: restore ON DELETE SET NULL on the project link.
--
-- The ghost rows removed by the up migration are not restored: they pointed at
-- projects that no longer exist, carried no assignments or configuration
-- history, and cannot be re-linked to anything.

ALTER TABLE hierarchy.repositories
  DROP CONSTRAINT IF EXISTS repositories_provisioned_project_id_fkey;

ALTER TABLE hierarchy.repositories
  ADD CONSTRAINT repositories_provisioned_project_id_fkey
  FOREIGN KEY (provisioned_project_id)
  REFERENCES projects.provisioned_projects(id)
  ON DELETE SET NULL;
