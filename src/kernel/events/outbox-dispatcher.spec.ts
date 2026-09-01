import { OutboxDispatcher } from './outbox-dispatcher';

describe('OutboxDispatcher', () => {
  it('dispatches a topic to its registered handler', async () => {
    const dispatcher = new OutboxDispatcher();
    const handler = {
      topics: ['platform.audit.recorded'],
      handle: jest.fn().mockResolvedValue(undefined),
    };
    dispatcher.register(handler);

    const event = {
      id: 'event-1',
      topic: 'platform.audit.recorded',
      aggregateType: 'audit_event',
      aggregateId: 'project-1',
      payload: {},
      createdAt: '2026-08-27T00:00:00.000Z',
    };

    await dispatcher.dispatch(event);

    expect(handler.handle).toHaveBeenCalledWith(event);
    expect(dispatcher.topics()).toEqual(['platform.audit.recorded']);
  });

  it('rejects an event for which no handler is registered', async () => {
    const dispatcher = new OutboxDispatcher();

    await expect(
      dispatcher.dispatch({
        id: 'event-1',
        topic: 'workflow.generated',
        aggregateType: 'workflow',
        aggregateId: 'user-1',
        payload: {},
        createdAt: '2026-08-27T00:00:00.000Z',
      }),
    ).rejects.toThrow("No outbox handler registered for 'workflow.generated'");
  });

  it('rejects duplicate topic ownership', () => {
    const dispatcher = new OutboxDispatcher();
    dispatcher.register({
      topics: ['platform.audit.recorded'],
      handle: jest.fn(),
    });

    expect(() =>
      dispatcher.register({
        topics: ['platform.audit.recorded'],
        handle: jest.fn(),
      }),
    ).toThrow("Outbox topic 'platform.audit.recorded' already has a handler");
  });

  it('rejects handlers for topics without an application owner', () => {
    const dispatcher = new OutboxDispatcher();

    expect(() =>
      dispatcher.register({
        topics: ['workflow.generated'],
        handle: jest.fn(),
      }),
    ).toThrow("Outbox topic 'workflow.generated' is not in the topic registry");
  });
});
