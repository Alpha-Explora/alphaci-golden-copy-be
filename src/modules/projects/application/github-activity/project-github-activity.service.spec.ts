import { NotFoundException } from '@nestjs/common';

import type { GitHubRepositoryEvent } from '#kernel/ports/github.port';
import type { ProvisionedProjectRow } from '../../infrastructure/projects.repository';
import {
  GITHUB_SYNC_MIN_INTERVAL_MS,
  ProjectGithubActivityService,
} from './project-github-activity.service';

const project = {
  id: 'project-1',
  repo_full_name: 'Acme/Orders',
  workspace_id: 'team-1',
} as unknown as ProvisionedProjectRow;

const push = (id: string): GitHubRepositoryEvent => ({
  id,
  type: 'PushEvent',
  actor: { login: 'dev' },
  createdAt: '2026-10-02T10:00:00Z',
  payload: {
    ref: 'refs/heads/dev',
    before: 'a'.repeat(40),
    head: 'b'.repeat(40),
  },
});

describe('ProjectGithubActivityService', () => {
  let github: {
    listRepositoryEvents: jest.Mock;
    compareCommits: jest.Mock;
    getPullRequestHeadline: jest.Mock;
  };
  let ingest: {
    isRecording: jest.Mock;
    findUnrecordedExternalIds: jest.Mock;
    ingestExternalEvents: jest.Mock;
    getGithubSyncState: jest.Mock;
    saveGithubSyncState: jest.Mock;
  };
  let tokens: { installationFirst: jest.Mock };
  let projectsRepository: { findByIdAndUser: jest.Mock };
  let service: ProjectGithubActivityService;

  beforeEach(() => {
    github = {
      listRepositoryEvents: jest.fn().mockResolvedValue({
        status: 'modified',
        etag: 'W/"1"',
        events: [push('1'), push('2')],
      }),
      compareCommits: jest.fn().mockResolvedValue({
        status: 'ahead',
        totalCommits: 3,
        commits: [{ sha: 's', message: 'fix: a\n\nb', authorName: 'Dev' }],
      }),
      getPullRequestHeadline: jest.fn().mockResolvedValue(null),
    };
    ingest = {
      isRecording: jest.fn().mockReturnValue(true),
      findUnrecordedExternalIds: jest
        .fn()
        .mockImplementation((ids: string[]) => Promise.resolve(new Set(ids))),
      ingestExternalEvents: jest.fn().mockResolvedValue({ inserted: 2 }),
      getGithubSyncState: jest.fn().mockResolvedValue(null),
      saveGithubSyncState: jest.fn().mockResolvedValue(undefined),
    };
    tokens = { installationFirst: jest.fn().mockResolvedValue('install-tok') };
    projectsRepository = { findByIdAndUser: jest.fn() };
    service = new ProjectGithubActivityService(
      projectsRepository as never,
      github as never,
      tokens as never,
      ingest as never,
    );
  });

  it('ingests the mapped events and stores the ETag and time', async () => {
    const result = await service.syncIfDue(project, 'user-1', 'oauth');

    expect(result).toMatchObject({ status: 'ok', ingested: 2 });
    expect(tokens.installationFirst).toHaveBeenCalledWith(
      'Acme/Orders',
      'user-1',
      'oauth',
    );
    expect(github.listRepositoryEvents).toHaveBeenCalledWith(
      'install-tok',
      'Acme/Orders',
      { etag: null },
    );
    const batch = ingest.ingestExternalEvents.mock.calls[0]?.[0] as {
      projectId: string;
      workspaceId: string;
      events: Array<{ externalId: string; message: string }>;
    };
    expect(batch).toMatchObject({
      projectId: 'project-1',
      workspaceId: 'team-1',
    });
    expect(batch.events.map((e) => e.externalId)).toEqual([
      'github:1',
      'github:2',
    ]);
    expect(batch.events[0]?.message).toBe('Pushed 3 commits to dev');
    expect(ingest.saveGithubSyncState).toHaveBeenCalledWith('acme/orders', {
      etag: 'W/"1"',
      syncedAt: expect.any(String),
    });
  });

  it('only looks up and ingests events that are not stored yet (dedupe on re-sync)', async () => {
    ingest.findUnrecordedExternalIds.mockResolvedValue(new Set(['github:2']));

    await service.syncIfDue(project, 'user-1', null);

    expect(github.compareCommits).toHaveBeenCalledTimes(1);
    const batch = ingest.ingestExternalEvents.mock.calls[0]?.[0] as {
      events: Array<{ externalId: string }>;
    };
    expect(batch.events.map((e) => e.externalId)).toEqual(['github:2']);
  });

  it('skips the sync when the last one is younger than 60 seconds', async () => {
    ingest.getGithubSyncState.mockResolvedValue({
      etag: 'W/"1"',
      syncedAt: new Date(
        Date.now() - GITHUB_SYNC_MIN_INTERVAL_MS + 5_000,
      ).toISOString(),
    });

    const result = await service.syncIfDue(project, 'user-1', null);

    expect(result).toMatchObject({ status: 'ok', ingested: 0 });
    expect(github.listRepositoryEvents).not.toHaveBeenCalled();
  });

  it('syncs again once the window has passed, with the stored ETag', async () => {
    ingest.getGithubSyncState.mockResolvedValue({
      etag: 'W/"old"',
      syncedAt: new Date(
        Date.now() - GITHUB_SYNC_MIN_INTERVAL_MS - 1_000,
      ).toISOString(),
    });

    await service.syncIfDue(project, 'user-1', null);

    expect(github.listRepositoryEvents).toHaveBeenCalledWith(
      'install-tok',
      'Acme/Orders',
      { etag: 'W/"old"' },
    );
  });

  it('force ignores the throttle', async () => {
    ingest.getGithubSyncState.mockResolvedValue({
      etag: null,
      syncedAt: new Date().toISOString(),
    });

    await service.syncIfDue(project, 'user-1', null, { force: true });

    expect(github.listRepositoryEvents).toHaveBeenCalledTimes(1);
  });

  it('a 304 stores nothing but refreshes the sync time', async () => {
    ingest.getGithubSyncState.mockResolvedValue({
      etag: 'W/"1"',
      syncedAt: '2026-01-01T00:00:00.000Z',
    });
    github.listRepositoryEvents.mockResolvedValue({ status: 'not_modified' });

    const result = await service.syncIfDue(project, 'user-1', null);

    expect(result).toMatchObject({ status: 'ok', ingested: 0 });
    expect(ingest.ingestExternalEvents).not.toHaveBeenCalled();
    expect(ingest.saveGithubSyncState).toHaveBeenCalledWith('acme/orders', {
      etag: 'W/"1"',
      syncedAt: expect.any(String),
    });
  });

  it('does nothing when audit recording is off', async () => {
    ingest.isRecording.mockReturnValue(false);

    await expect(
      service.syncIfDue(project, 'user-1', null),
    ).resolves.toBeNull();
    expect(ingest.getGithubSyncState).not.toHaveBeenCalled();
    expect(github.listRepositoryEvents).not.toHaveBeenCalled();
    expect(service.isEnabled()).toBe(false);
  });

  it('reports failed (and keeps the last sync time) when GitHub errors, then backs off for a minute', async () => {
    ingest.getGithubSyncState.mockResolvedValue({
      etag: null,
      syncedAt: '2026-01-01T00:00:00.000Z',
    });
    github.listRepositoryEvents.mockRejectedValue(new Error('502'));

    const first = await service.syncIfDue(project, 'user-1', null);
    expect(first).toEqual({
      status: 'failed',
      syncedAt: '2026-01-01T00:00:00.000Z',
      ingested: 0,
    });
    expect(ingest.saveGithubSyncState).not.toHaveBeenCalled();

    const second = await service.syncIfDue(project, 'user-1', null);
    expect(second?.status).toBe('failed');
    expect(github.listRepositoryEvents).toHaveBeenCalledTimes(1);
  });

  it('reports failed without calling GitHub when no token resolves', async () => {
    tokens.installationFirst.mockResolvedValue(null);

    const result = await service.syncIfDue(project, 'user-1', null);

    expect(result?.status).toBe('failed');
    expect(github.listRepositoryEvents).not.toHaveBeenCalled();
  });

  it('returns stale after the budget and lets the sync finish in the background', async () => {
    let release: (value: unknown) => void = () => undefined;
    github.listRepositoryEvents.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const result = await service.syncIfDue(project, 'user-1', null, {
      budgetMs: 10,
    });

    expect(result).toEqual({ status: 'stale', syncedAt: null, ingested: null });
    expect(ingest.ingestExternalEvents).not.toHaveBeenCalled();

    release({ status: 'modified', etag: 'W/"2"', events: [push('9')] });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ingest.ingestExternalEvents).toHaveBeenCalledTimes(1);
    expect(ingest.saveGithubSyncState).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent syncs of one repository into one GitHub read', async () => {
    const [a, b] = await Promise.all([
      service.syncIfDue(project, 'user-1', null),
      service.syncIfDue(project, 'user-2', null),
    ]);

    expect(a?.status).toBe('ok');
    expect(b?.status).toBe('ok');
    expect(github.listRepositoryEvents).toHaveBeenCalledTimes(1);
  });

  it('survives a failed detail lookup: the event is stored with a plain message', async () => {
    github.compareCommits.mockRejectedValue(new Error('rate limited'));

    await service.syncIfDue(project, 'user-1', null);

    const batch = ingest.ingestExternalEvents.mock.calls[0]?.[0] as {
      events: Array<{ message: string }>;
    };
    expect(batch.events[0]?.message).toBe('Pushed to dev');
  });

  describe('syncProject', () => {
    it('is 404 for a project the caller cannot see', async () => {
      projectsRepository.findByIdAndUser.mockResolvedValue(null);

      await expect(
        service.syncProject('project-1', 'user-1', null),
      ).rejects.toThrow(NotFoundException);
      expect(github.listRepositoryEvents).not.toHaveBeenCalled();
    });

    it('forces a sync for a visible project', async () => {
      projectsRepository.findByIdAndUser.mockResolvedValue(project);
      ingest.getGithubSyncState.mockResolvedValue({
        etag: null,
        syncedAt: new Date().toISOString(),
      });

      const result = await service.syncProject('project-1', 'user-1', 'oauth');

      expect(result).toMatchObject({ status: 'ok', ingested: 2 });
      expect(github.listRepositoryEvents).toHaveBeenCalledTimes(1);
    });

    it('answers disabled when recording is off', async () => {
      projectsRepository.findByIdAndUser.mockResolvedValue(project);
      ingest.isRecording.mockReturnValue(false);

      await expect(
        service.syncProject('project-1', 'user-1', null),
      ).resolves.toEqual({ status: 'disabled', syncedAt: null, ingested: 0 });
    });
  });
});
