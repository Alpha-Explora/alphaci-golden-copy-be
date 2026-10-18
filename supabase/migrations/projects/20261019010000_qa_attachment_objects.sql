-- QA screenshot bytes for deployments without Supabase Storage (STORAGE_DRIVER=postgres),
-- phase WP-A of the self-hosted appliance.
--
-- Additive only: one new table, nothing existing is altered. The Supabase
-- driver (SaaS) keeps its private `qa-attachments` bucket and never reads this
-- table, so applying this migration changes no behaviour for it.
--
-- Scope: the bytes of each attachment, keyed by the same storage_path the
-- attachment metadata row carries (projects.qa_run_item_attachments.storage_path,
-- "<run_id>/<run_item_id>/<id>.<ext>"). The backend writes and reads this table
-- with its own database role and serves bytes only through HMAC-signed links; no
-- client ever queries it directly. RLS is enabled with no policies, the same
-- pattern as the other QA tables, so a role that is not the table owner sees
-- nothing.
--
-- Cross-context note: there is deliberately no foreign key to
-- projects.qa_run_item_attachments. The backend uploads the bytes before it
-- inserts the metadata row, so a foreign key would reject the first write. The
-- backend removes the object when it removes the row. Known gap: a database-level
-- cascade (deleting a run or project) removes the metadata rows but not these
-- bytes. Those orphans need a retention sweep; they are unreachable, not exposed.
--
-- Cold-replay note: every constraint is inline in CREATE TABLE, so a fresh
-- replay and a re-run both succeed (CREATE ... IF NOT EXISTS on an object whose
-- full definition is in this file).

CREATE TABLE IF NOT EXISTS projects.qa_attachment_objects (
  -- <run_id>/<run_item_id>/<id>.<ext>; the attachment's storage_path.
  storage_path TEXT PRIMARY KEY
    CONSTRAINT qa_attachment_objects_storage_path_chk
    CHECK (char_length(storage_path) BETWEEN 1 AND 512),
  content_type TEXT NOT NULL
    CONSTRAINT qa_attachment_objects_content_type_chk
    CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  -- 3 MB per object, the same cap as the Supabase bucket and the product rule.
  byte_size INTEGER NOT NULL
    CONSTRAINT qa_attachment_objects_byte_size_chk
    CHECK (byte_size > 0 AND byte_size <= 3145728),
  bytes BYTEA NOT NULL
    CONSTRAINT qa_attachment_objects_bytes_chk
    CHECK (octet_length(bytes) = byte_size),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE projects.qa_attachment_objects ENABLE ROW LEVEL SECURITY;
