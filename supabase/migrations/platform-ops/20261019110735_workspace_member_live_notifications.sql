-- Explicit workspace context also supports notifications without a repository.
ALTER TABLE notifications.notifications
  ADD COLUMN IF NOT EXISTS workspace_id UUID NULL REFERENCES orgs.workspaces(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_event_id UUID NULL;

-- Events can be retried after the notification insert but before outbox ack.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_recipient_source_event
  ON notifications.notifications(user_id, source_event_id)
  WHERE source_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications.notifications(user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_workspace
  ON notifications.notifications(workspace_id) WHERE workspace_id IS NOT NULL;
