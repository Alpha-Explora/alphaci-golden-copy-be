/**
 * The only topics that the application-owned outbox currently emits and
 * consumes. Keeping this registry in the kernel gives both producers and the
 * single relay a compile-time and runtime allow-list; an event without an
 * owner must not become an invisible pending-row backlog.
 */
export const OUTBOX_TOPICS = {
  platformAuditRecorded: 'platform.audit.recorded',
  platformNotificationRequested: 'platform.notification.requested',
  hierarchyAssignmentGrant: 'hierarchy.repository_assignment.grant',
  hierarchyAssignmentRevoke: 'hierarchy.repository_assignment.revoke',
} as const;

export type OutboxTopic = (typeof OUTBOX_TOPICS)[keyof typeof OUTBOX_TOPICS];

export const OUTBOX_TOPIC_OWNERS: Readonly<Record<OutboxTopic, string>> = {
  [OUTBOX_TOPICS.platformAuditRecorded]: 'platform-ops',
  [OUTBOX_TOPICS.platformNotificationRequested]: 'platform-ops',
  [OUTBOX_TOPICS.hierarchyAssignmentGrant]: 'identity-access',
  [OUTBOX_TOPICS.hierarchyAssignmentRevoke]: 'identity-access',
};

export function isRegisteredOutboxTopic(topic: string): topic is OutboxTopic {
  return Object.prototype.hasOwnProperty.call(OUTBOX_TOPIC_OWNERS, topic);
}
