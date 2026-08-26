import {
  decodePlatformEvent,
  PLATFORM_EVENT_TOPICS,
} from './platform-event.registry';

describe('platform event registry', () => {
  it('decodes the audit contract without framework objects', () => {
    expect(
      decodePlatformEvent(PLATFORM_EVENT_TOPICS.auditRecorded, {
        projectId: 'project-1',
        eventCode: 'project.updated',
        message: 'Project updated',
        metadata: { source: 'test' },
      }),
    ).toEqual({
      topic: PLATFORM_EVENT_TOPICS.auditRecorded,
      payload: {
        projectId: 'project-1',
        eventCode: 'project.updated',
        message: 'Project updated',
        metadata: { source: 'test' },
      },
    });
  });

  it('rejects unknown topics and malformed payloads', () => {
    expect(() => decodePlatformEvent('platform.unknown', {})).toThrow(
      "Unsupported platform event topic 'platform.unknown'",
    );
    expect(() =>
      decodePlatformEvent(PLATFORM_EVENT_TOPICS.notificationRequested, {
        userId: 'user-1',
        eventCode: 'project.updated',
        title: 'Missing body',
      }),
    ).toThrow("Platform event field 'body' must be a non-empty string");
  });
});
