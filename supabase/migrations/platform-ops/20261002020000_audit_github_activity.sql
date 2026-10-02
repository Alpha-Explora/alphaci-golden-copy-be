-- GitHub repository activity in the Audit trail.
--
-- Developers pushed straight to `dev` and no pull request ever existed, so the
-- repository Audit tab showed nothing of what actually happened on GitHub. The
-- backend now reads each repository's GitHub Events API and ingests pushes,
-- pull requests, branches and tags into audit.audit_events next to ALPHACI's
-- own events (webhooks are not reaching the backend, so this is polled).
--
-- DEDUPE. audit.audit_events gains `external_id TEXT NULL`, set to
-- `github:<event id>` for ingested rows and NULL for every row ALPHACI records
-- itself. A UNIQUE index on it makes re-syncing the same events a no-op
-- (INSERT ... ON CONFLICT (external_id) DO NOTHING); NULLs never conflict, so
-- it does not constrain normal inserts. GitHub event ids are unique across all
-- repositories, so one global index is enough. The column is deliberately
-- generic (not `github_event_id`) so another source can reuse it with its own
-- prefix.
--
-- SYNC STATE. audit.github_event_syncs holds one row per repository (lower-case
-- full name): the ETag of the last Events API page 1 and when the last
-- successful sync finished. The ETag lets an unchanged repository cost a single
-- conditional GET (304); the time drives the 60 second throttle across backend
-- instances. It is keyed by name rather than by a project id so that no
-- cross-schema foreign key is needed (the projects module owns that mapping).
--
-- Cold replay: audit.audit_events exists from 20260614000300; every statement
-- below is valid on an empty database. IF NOT EXISTS only makes a re-run a
-- no-op, it does not guard anything that could be wrong.
BEGIN;

ALTER TABLE audit.audit_events
  ADD COLUMN IF NOT EXISTS external_id TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_events_external_id
  ON audit.audit_events (external_id);

CREATE TABLE IF NOT EXISTS audit.github_event_syncs (
  repo_full_name TEXT PRIMARY KEY,
  etag TEXT NULL,
  last_synced_at TIMESTAMPTZ NOT NULL
);

-- Same posture as the other audit tables: the backend connects with a role
-- that bypasses RLS; the public API roles get nothing.
ALTER TABLE audit.github_event_syncs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON audit.github_event_syncs FROM anon, authenticated;

COMMIT;
