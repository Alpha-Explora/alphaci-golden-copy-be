/**
 * Integration events emitted by the application-owned transactional outbox.
 *
 * The registry lives in kernel so producers do not import platform-ops.  It is
 * deliberately small and serialisable: these values are the contract a
 * separate consumer process can consume, not an internal Nest service API.
 */
import { OUTBOX_TOPICS } from './outbox-topics';

export const PLATFORM_EVENT_TOPICS = {
  auditRecorded: OUTBOX_TOPICS.platformAuditRecorded,
  notificationRequested: OUTBOX_TOPICS.platformNotificationRequested,
} as const;

export type PlatformEventTopic =
  (typeof PLATFORM_EVENT_TOPICS)[keyof typeof PLATFORM_EVENT_TOPICS];

export interface AuditRecordedEventPayload {
  workspaceId?: string | null;
  projectId?: string | null;
  actorUserId?: string | null;
  eventCode: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface NotificationRequestedEventPayload {
  userId: string;
  projectId?: string | null;
  workspaceId?: string | null;
  eventCode: string;
  title: string;
  body: string;
}

export type PlatformEvent =
  | {
      topic: typeof PLATFORM_EVENT_TOPICS.auditRecorded;
      payload: AuditRecordedEventPayload;
    }
  | {
      topic: typeof PLATFORM_EVENT_TOPICS.notificationRequested;
      payload: NotificationRequestedEventPayload;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  payload: Record<string, unknown>,
  field: string,
): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Platform event field '${field}' must be a non-empty string`,
    );
  }
  return value;
}

function optionalStringOrNull(
  payload: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = payload[field];
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== 'string') {
    throw new Error(`Platform event field '${field}' must be a string or null`);
  }
  return value;
}

/** Decode and validate JSON returned by pg before dispatching it. */
export function decodePlatformEvent(
  topic: string,
  value: unknown,
): PlatformEvent {
  if (!isRecord(value)) {
    throw new Error(`Payload for '${topic}' must be a JSON object`);
  }

  if (topic === PLATFORM_EVENT_TOPICS.auditRecorded) {
    const workspaceId = optionalStringOrNull(value, 'workspaceId');
    const projectId = optionalStringOrNull(value, 'projectId');
    const actorUserId = optionalStringOrNull(value, 'actorUserId');
    const metadata = value.metadata;
    return {
      topic: PLATFORM_EVENT_TOPICS.auditRecorded,
      payload: {
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(projectId === undefined ? {} : { projectId }),
        ...(actorUserId === undefined ? {} : { actorUserId }),
        eventCode: requireString(value, 'eventCode'),
        message: requireString(value, 'message'),
        ...(metadata === undefined
          ? {}
          : isRecord(metadata)
            ? { metadata }
            : (() => {
                throw new Error(
                  "Platform event field 'metadata' must be a JSON object",
                );
              })()),
      },
    };
  }

  if (topic === PLATFORM_EVENT_TOPICS.notificationRequested) {
    const projectId = optionalStringOrNull(value, 'projectId');
    const workspaceId = optionalStringOrNull(value, 'workspaceId');
    return {
      topic: PLATFORM_EVENT_TOPICS.notificationRequested,
      payload: {
        userId: requireString(value, 'userId'),
        ...(projectId === undefined ? {} : { projectId }),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        eventCode: requireString(value, 'eventCode'),
        title: requireString(value, 'title'),
        body: requireString(value, 'body'),
      },
    };
  }

  throw new Error(`Unsupported platform event topic '${topic}'`);
}
