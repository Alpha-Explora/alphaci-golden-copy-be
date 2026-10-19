-- Rollback for 20261019010000_qa_attachment_objects.sql.
--
-- Dropping the table deletes every stored screenshot's bytes, which the
-- metadata rows still point at. So this fails closed while any object exists:
-- export or move the bytes first, then re-run. Nothing is deleted implicitly.

BEGIN;

DO $$
DECLARE
  stored BIGINT;
BEGIN
  IF to_regclass('projects.qa_attachment_objects') IS NULL THEN
    RETURN;
  END IF;
  SELECT COUNT(*) INTO stored FROM projects.qa_attachment_objects;
  IF stored > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop projects.qa_attachment_objects: % stored screenshot(s) would lose their bytes. Export or remove them first.',
      stored;
  END IF;
END
$$;

DROP TABLE IF EXISTS projects.qa_attachment_objects;

COMMIT;
