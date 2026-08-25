-- Down: no automatic reversal.
--
-- The up migration writes the same systems -> delivery_projects -> repositories
-- rows that `ensureLink` writes at project creation, and records nothing to
-- distinguish a backfilled chain from one created normally. Deleting "the
-- backfilled ones" would therefore mean guessing, and a wrong guess destroys a
-- real project tree along with any repository assignments hanging off it.
--
-- The rows are additive and inert: a project that has a hierarchy link simply
-- becomes assignable. There is nothing to undo for correctness.
--
-- To unlink one specific project, delete its chain by id, innermost first:
--
--   DELETE FROM hierarchy.repositories      WHERE provisioned_project_id = '<project-id>';
--   DELETE FROM hierarchy.delivery_projects WHERE id = '<delivery-project-id>';
--   DELETE FROM hierarchy.systems           WHERE id = '<system-id>';

SELECT 'No automatic rollback — see the comment in this file.' AS note;
