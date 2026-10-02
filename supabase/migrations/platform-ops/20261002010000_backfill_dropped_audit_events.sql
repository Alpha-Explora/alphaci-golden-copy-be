-- Backfill audit events that were dropped while AUDIT_EVENTS_ENABLED was off.
--
-- Recording is gated by the `platform.audit-events` capability. While it was
-- off, every `platform.audit.recorded` outbox event was published, handed to
-- AuditEventsService.record and silently discarded, so the repository Audit
-- tab has no history. The payloads are still in platform.outbox_events (status
-- 'published'); this copies them into audit.audit_events once.
--
-- Mapping (AuditRecordedEventPayload -> audit.audit_events):
--   payload.workspaceId  -> workspace_id   (NULL when the workspace is gone)
--   payload.projectId    -> project_id     (NULL when the project is gone)
--   payload.actorUserId  -> actor_user_id  (no FK)
--   payload.eventCode    -> event_code
--   payload.message      -> message
--   payload.metadata     -> metadata_json  (+ backfill markers)
--   outbox created_at    -> created_at     (the real event time)
--
-- DEDUPE. audit.audit_events gains `outbox_event_id UUID NULL UNIQUE`, set to
-- the source outbox row id, and the insert is ON CONFLICT DO NOTHING on it.
-- A natural key (event_code, project_id, created_at, actor) was rejected
-- because two identical events can share a timestamp and because a backfilled
-- row's time is the outbox time, not the live one. The column is NULL for
-- every live-recorded row, so it does not constrain normal inserts. There is no
-- FK to platform.outbox_events: the outbox is pruned, the audit row must not
-- be.
--
-- A second guard covers the window between turning recording on and applying
-- this migration: those events were recorded live (no outbox_event_id) AND are
-- still in the outbox. An outbox row is skipped when an unlinked audit row has
-- the same event_code, message, project and actor within [-1 min, +10 min] of
-- its time (the handler runs shortly after the outbox row is written).
--
-- DELETED PARENTS. audit_events.project_id and workspace_id are FKs. A payload
-- for a repository or team that has since been deleted (for example
-- project_github_repo_deleted) must not fail the insert or be lost, so the id
-- is nulled instead of the row skipped; the original id is kept in metadata.
--
-- Cold replay: on an empty database the outbox is empty, the insert adds zero
-- rows, and every statement is valid SQL (the IF NOT EXISTS clauses only make
-- a re-run a no-op; they do not guard anything that could be wrong).
BEGIN;

ALTER TABLE audit.audit_events
  ADD COLUMN IF NOT EXISTS outbox_event_id UUID NULL UNIQUE;

-- Project-level events (project_id IS NULL, metadata.deliveryProjectId set)
-- are listed on every repository of the Project.
CREATE INDEX IF NOT EXISTS idx_audit_events_delivery_project_created
  ON audit.audit_events ((metadata_json ->> 'deliveryProjectId'), created_at DESC)
  WHERE project_id IS NULL;

INSERT INTO audit.audit_events (
  workspace_id,
  project_id,
  actor_user_id,
  event_code,
  message,
  metadata_json,
  created_at,
  outbox_event_id
)
SELECT
  workspace.id,
  project.id,
  source.actor_user_id,
  source.event_code,
  source.message,
  source.metadata
    || jsonb_build_object('backfilledFromOutbox', TRUE)
    || CASE
         WHEN source.project_id IS NOT NULL AND project.id IS NULL
           THEN jsonb_build_object('originalProjectId', source.project_id)
         ELSE '{}'::jsonb
       END
    || CASE
         WHEN source.workspace_id IS NOT NULL AND workspace.id IS NULL
           THEN jsonb_build_object('originalWorkspaceId', source.workspace_id)
         ELSE '{}'::jsonb
       END,
  source.created_at,
  source.outbox_event_id
FROM (
  SELECT
    outbox.id AS outbox_event_id,
    outbox.created_at,
    outbox.payload ->> 'eventCode' AS event_code,
    outbox.payload ->> 'message' AS message,
    CASE
      WHEN jsonb_typeof(outbox.payload -> 'metadata') = 'object'
        THEN outbox.payload -> 'metadata'
      ELSE '{}'::jsonb
    END AS metadata,
    CASE
      WHEN outbox.payload ->> 'projectId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (outbox.payload ->> 'projectId')::uuid
    END AS project_id,
    CASE
      WHEN outbox.payload ->> 'workspaceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (outbox.payload ->> 'workspaceId')::uuid
    END AS workspace_id,
    CASE
      WHEN outbox.payload ->> 'actorUserId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (outbox.payload ->> 'actorUserId')::uuid
    END AS actor_user_id
  FROM platform.outbox_events AS outbox
  WHERE outbox.topic = 'platform.audit.recorded'
    AND outbox.status = 'published'
    AND jsonb_typeof(outbox.payload) = 'object'
    AND jsonb_typeof(outbox.payload -> 'eventCode') = 'string'
    AND outbox.payload ->> 'eventCode' <> ''
    AND jsonb_typeof(outbox.payload -> 'message') = 'string'
    AND outbox.payload ->> 'message' <> ''
) AS source
LEFT JOIN projects.provisioned_projects AS project
  ON project.id = source.project_id
LEFT JOIN orgs.workspaces AS workspace
  ON workspace.id = source.workspace_id
WHERE NOT EXISTS (
  SELECT 1
  FROM audit.audit_events AS live
  WHERE live.outbox_event_id IS NULL
    AND live.event_code = source.event_code
    AND live.message = source.message
    AND (live.project_id = project.id OR (live.project_id IS NULL AND project.id IS NULL))
    AND (
      live.actor_user_id = source.actor_user_id
      OR (live.actor_user_id IS NULL AND source.actor_user_id IS NULL)
    )
    AND live.created_at >= source.created_at - INTERVAL '1 minute'
    AND live.created_at <= source.created_at + INTERVAL '10 minutes'
)
ORDER BY source.created_at, source.outbox_event_id
ON CONFLICT (outbox_event_id) DO NOTHING;

COMMIT;
