-- The application relay owns platform.outbox_events, but it only dispatches
-- topics with a registered in-process handler. These topics were emitted by
-- the removed Kafka-era producers and have no consumer in this deployment.
-- Preserve the rows for auditability while keeping them out of the pending
-- queue; new code is prevented from creating them by the kernel topic registry.
UPDATE platform.outbox_events
SET status = 'ignored',
    updated_at = NOW()
WHERE status = 'pending'
  AND topic IN (
    'user.signed_in',
    'subscription.activated',
    'subscription.canceled',
    'workflow.generated',
    'hierarchy.repository_assignment.reconcile'
  );
