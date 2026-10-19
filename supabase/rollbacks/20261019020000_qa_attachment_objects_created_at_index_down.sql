-- Rollback for 20261019020000_qa_attachment_objects_created_at_index.sql.
--
-- Drops only the index. The sweep still runs without it, just with a slower
-- scan of the bytes table. No rows are touched.

DROP INDEX IF EXISTS projects.idx_qa_attachment_objects_created_at;
