-- QA run item attachments (screenshots as evidence), phase A1.
--
-- Additive only: nothing existing is altered. The backend deployed before this
-- change never reads these objects, so apply this BEFORE the backend that uses
-- it deploys (docs: QA_ATTACHMENTS_PLAN.md, sections 3 and 7).
--
-- Scope: one table holding the metadata of an image attached to a Project run
-- item, and the PRIVATE Supabase Storage bucket `qa-attachments` that holds the
-- bytes. The backend uploads with the service role key and hands out
-- short-lived signed URLs after its own role check; the bucket has no public
-- access and no storage policies, so nothing else can read it.
--
-- Cross-context note: created_by is a plain UUID with NO foreign key, same
-- pattern as the other QA tables (scripts/check-schema-ownership.cjs restricts
-- the `projects` context to the `projects` and `workflow` schemas). The bucket
-- insert below touches storage.buckets, a Supabase-owned table; it is a
-- reviewed exact-pair transition entry in that gate, not a blanket exemption.
--
-- Cold-replay note: every constraint is written inline in its CREATE TABLE so a
-- fresh replay can never observe a table without it, and a re-run is a no-op
-- (CREATE ... IF NOT EXISTS on objects whose full definition is in this file;
-- ON CONFLICT DO NOTHING on the bucket).

CREATE TABLE IF NOT EXISTS projects.qa_run_item_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL
    REFERENCES projects.qa_verification_runs(id) ON DELETE CASCADE,
  run_item_id UUID NOT NULL
    REFERENCES projects.qa_run_items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CONSTRAINT qa_run_item_attachments_kind_chk
    CHECK (kind IN ('evidence', 'fix_proof', 'automated')),
  -- <run_id>/<run_item_id>/<id>.<ext>
  storage_path TEXT NOT NULL
    CONSTRAINT qa_run_item_attachments_storage_path_uq UNIQUE,
  content_type TEXT NOT NULL
    CONSTRAINT qa_run_item_attachments_content_type_chk
    CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_size INTEGER NOT NULL
    CONSTRAINT qa_run_item_attachments_byte_size_chk
    CHECK (byte_size > 0 AND byte_size <= 3145728),
  width INTEGER NOT NULL
    CONSTRAINT qa_run_item_attachments_width_chk CHECK (width BETWEEN 1 AND 8000),
  height INTEGER NOT NULL
    CONSTRAINT qa_run_item_attachments_height_chk CHECK (height BETWEEN 1 AND 8000),
  caption TEXT NULL
    CONSTRAINT qa_run_item_attachments_caption_length_chk
    CHECK (char_length(caption) <= 280),
  source TEXT NOT NULL
    CONSTRAINT qa_run_item_attachments_source_chk
    CHECK (source IN ('capture', 'paste', 'upload', 'playwright')),
  -- Automated attachments: the Playwright test the image came from.
  test_title TEXT NULL,
  -- NULL for automated attachments (no human uploaded them).
  created_by UUID NULL,
  created_by_login TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qa_run_item_attachments_item_created
  ON projects.qa_run_item_attachments (run_item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_qa_run_item_attachments_run
  ON projects.qa_run_item_attachments (run_id);

ALTER TABLE projects.qa_run_item_attachments ENABLE ROW LEVEL SECURITY;

-- Private bucket: 3 MB per object, images only. public = false means the object
-- URLs are not readable without a signed URL; there are deliberately no
-- storage.objects policies, so only the service role (the backend) can touch it.
--
-- Guarded: storage.buckets exists only where Supabase Storage is installed. On
-- a plain PostgreSQL database (self-hosted) the bucket is skipped, and the
-- table itself is still created above. Where the table exists, the insert is
-- the same as before.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'qa-attachments',
      'qa-attachments',
      false,
      3145728,
      ARRAY['image/png', 'image/jpeg', 'image/webp']
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;
END
$$;
