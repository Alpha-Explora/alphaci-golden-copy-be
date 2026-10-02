import { AuditEventsService } from './audit-events.service';

describe('AuditEventsService, GitHub activity ingest', () => {
  const repository = {
    findRecordedExternalIds: jest.fn(),
    insertExternalBatch: jest.fn(),
    findGithubSyncState: jest.fn(),
    saveGithubSyncState: jest.fn(),
  };
  const capabilityResolver = { deployment: jest.fn() };

  const batch = {
    projectId: 'repo-1',
    workspaceId: 'team-1',
    events: [
      {
        externalId: 'github:1',
        eventCode: 'github.push',
        message: 'Pushed to dev',
        metadata: {},
        actorLogin: 'dev',
        occurredAt: '2026-10-02T10:00:00Z',
      },
    ],
  };
  const make = () =>
    new AuditEventsService(repository as never, capabilityResolver as never);

  beforeEach(() => {
    jest.clearAllMocks();
    capabilityResolver.deployment.mockReturnValue(
      new Set(['platform.audit-events']),
    );
  });

  it('stores events and reports how many were new when recording is on', async () => {
    repository.insertExternalBatch.mockResolvedValue(1);

    const service = make();
    expect(service.isRecording()).toBe(true);
    await expect(service.ingestExternalEvents(batch)).resolves.toEqual({
      inserted: 1,
    });
    expect(repository.insertExternalBatch).toHaveBeenCalledWith(batch);
  });

  it('stores nothing and reads nothing when recording is off', async () => {
    capabilityResolver.deployment.mockReturnValue(new Set());
    const service = make();

    expect(service.isRecording()).toBe(false);
    await expect(service.ingestExternalEvents(batch)).resolves.toEqual({
      inserted: 0,
    });
    await expect(
      service.findUnrecordedExternalIds(['github:1']),
    ).resolves.toEqual(new Set());
    expect(repository.insertExternalBatch).not.toHaveBeenCalled();
    expect(repository.findRecordedExternalIds).not.toHaveBeenCalled();
  });

  it('returns the ids that are not stored yet', async () => {
    repository.findRecordedExternalIds.mockResolvedValue(new Set(['github:1']));

    await expect(
      make().findUnrecordedExternalIds(['github:1', 'github:2']),
    ).resolves.toEqual(new Set(['github:2']));
  });

  it('passes the sync state through', async () => {
    repository.findGithubSyncState.mockResolvedValue({
      etag: 'e',
      syncedAt: 't',
    });

    const service = make();
    await expect(service.getGithubSyncState('a/b')).resolves.toEqual({
      etag: 'e',
      syncedAt: 't',
    });
    await service.saveGithubSyncState('a/b', { etag: 'f', syncedAt: 'u' });
    expect(repository.saveGithubSyncState).toHaveBeenCalledWith('a/b', {
      etag: 'f',
      syncedAt: 'u',
    });
  });
});
