-- Rollback for 20260827000000_quarantine_unowned_outbox_topics.sql
--
-- The quarantine migration only changes the listed legacy topics. Requeue those
-- rows so a previous application version can inspect and route them using its
-- own delivery path. This is intentionally scoped to the exact topic list and
-- does not revive unrelated operator-ignored rows.
BEGIN;

UPDATE platform.outbox_events
SET status = 'pending',
    available_at = COALESCE(available_at, NOW()),
    updated_at = NOW()
WHERE status = 'ignored'
  AND topic IN (
    'user.signed_in',
    'subscription.activated',
    'subscription.canceled',
    'workflow.generated',
    'hierarchy.repository_assignment.reconcile'
  );

COMMIT;
