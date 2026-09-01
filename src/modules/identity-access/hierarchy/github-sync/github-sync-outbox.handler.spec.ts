import { OutboxDispatcher } from '#kernel/events/outbox-dispatcher';
import { HIERARCHY_OUTBOX_TOPICS } from '../hierarchy.types';
import { GithubSyncOutboxHandler } from './github-sync-outbox.handler';

describe('GithubSyncOutboxHandler', () => {
  it('registers hierarchy topics with the central dispatcher', async () => {
    const dispatcher = new OutboxDispatcher();
    const githubSyncService = {
      processJob: jest.fn().mockResolvedValue(undefined),
    };
    const handler = new GithubSyncOutboxHandler(
      dispatcher,
      githubSyncService as never,
    );
    handler.onModuleInit();

    const event = {
      id: 'event-1',
      topic: HIERARCHY_OUTBOX_TOPICS.grant,
      aggregateType: 'repository_assignment',
      aggregateId: 'assignment-1',
      payload: { assignmentId: 'assignment-1', actingUserId: 'pm-1' },
      createdAt: '2026-08-27T00:00:00.000Z',
    };

    await dispatcher.dispatch(event);

    expect(githubSyncService.processJob).toHaveBeenCalledWith(
      HIERARCHY_OUTBOX_TOPICS.grant,
      event.payload,
    );
    expect(dispatcher.topics()).toEqual([
      HIERARCHY_OUTBOX_TOPICS.grant,
      HIERARCHY_OUTBOX_TOPICS.revoke,
    ]);
  });

  it('rejects malformed hierarchy payloads before invoking the sync service', async () => {
    const dispatcher = new OutboxDispatcher();
    const githubSyncService = {
      processJob: jest.fn().mockResolvedValue(undefined),
    };
    const handler = new GithubSyncOutboxHandler(
      dispatcher,
      githubSyncService as never,
    );
    handler.onModuleInit();

    await expect(
      dispatcher.dispatch({
        id: 'event-1',
        topic: HIERARCHY_OUTBOX_TOPICS.revoke,
        aggregateType: 'repository_assignment',
        aggregateId: 'assignment-1',
        payload: { assignmentId: 'assignment-1' },
        createdAt: '2026-08-27T00:00:00.000Z',
      }),
    ).rejects.toThrow("Hierarchy outbox field 'actingUserId' must be a string");
    expect(githubSyncService.processJob).not.toHaveBeenCalled();
  });
});
