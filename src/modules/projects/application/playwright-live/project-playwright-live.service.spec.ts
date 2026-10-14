import { NotFoundException } from '@nestjs/common';

import type {
  GitHubRunJob,
  GitHubWorkflowRunSummary,
  GithubProjectPort,
} from '#kernel/ports/github.port';
import type {
  PlaywrightLivePort,
  PlaywrightLiveRunFacts,
} from '#kernel/ports/playwright-live.port';
import type { ProjectsRepository } from '../../infrastructure/projects.repository';
import type { ProjectGithubTokenResolver } from '../github-activity/project-github-token.resolver';
import {
  PLAYWRIGHT_LIVE_GITHUB_CACHE_MS,
  ProjectPlaywrightLiveService,
} from './project-playwright-live.service';

const ghRun = (
  overrides: Partial<GitHubWorkflowRunSummary> = {},
): GitHubWorkflowRunSummary => ({
  id: 200,
  name: 'Verify',
  displayTitle: '',
  headBranch: 'uat',
  headSha: 'f'.repeat(40),
  event: 'workflow_dispatch',
  status: 'queued',
  conclusion: null,
  runNumber: 1,
  runAttempt: 1,
  htmlUrl: '',
  actor: null,
  createdAt: '2026-10-08T10:00:00.000Z',
  updatedAt: '2026-10-08T10:00:02.000Z',
  ...overrides,
});

const job = (
  name: string,
  steps: Array<[string, string]>,
  status = 'in_progress',
): GitHubRunJob => ({
  id: 1,
  name,
  status,
  conclusion: null,
  startedAt: '2026-10-08T10:00:10.000Z',
  completedAt: null,
  htmlUrl: null,
  steps: steps.map(([stepName, stepStatus], index) => ({
    name: stepName,
    status: stepStatus,
    conclusion: null,
    number: index + 1,
    startedAt: null,
    completedAt: null,
  })),
});

const ingested = (
  overrides: Partial<PlaywrightLiveRunFacts> = {},
): PlaywrightLiveRunFacts => ({
  runId: 200,
  runAttempt: 1,
  commitSha: 'f'.repeat(40),
  branch: 'uat',
  status: 'running',
  startedAt: '2026-10-08T10:01:00.000Z',
  updatedAt: '2026-10-08T10:01:05.000Z',
  finishedAt: null,
  total: 4,
  done: 1,
  passed: 1,
  failed: 0,
  skipped: 0,
  running: [],
  tests: [],
  ...overrides,
});

describe('ProjectPlaywrightLiveService', () => {
  let projects: { findByIdAndUser: jest.Mock };
  let live: { getLatestRun: jest.Mock };
  let github: {
    getLatestWorkflowFileRun: jest.Mock;
    getWorkflowRunJobs: jest.Mock;
  };
  let tokens: { installationFirst: jest.Mock };
  let service: ProjectPlaywrightLiveService;

  const get = () => service.getLive('p1', 'u1', 'oauth', 'uat');

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-08T10:00:00.000Z') });
    projects = {
      findByIdAndUser: jest.fn().mockResolvedValue({
        repo_full_name: 'o/r',
        workflow_path: '.github/workflows/00-alphaci-access-api.yml',
      }),
    };
    live = { getLatestRun: jest.fn().mockResolvedValue(null) };
    github = {
      getLatestWorkflowFileRun: jest.fn().mockResolvedValue(null),
      getWorkflowRunJobs: jest.fn().mockResolvedValue([]),
    };
    tokens = { installationFirst: jest.fn().mockResolvedValue('app-token') };
    service = new ProjectPlaywrightLiveService(
      projects as unknown as ProjectsRepository,
      live as unknown as PlaywrightLivePort,
      github as unknown as GithubProjectPort,
      tokens as unknown as ProjectGithubTokenResolver,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is a 404 for a project the caller cannot see, before any read', async () => {
    projects.findByIdAndUser.mockResolvedValue(null);
    await expect(get()).rejects.toBeInstanceOf(NotFoundException);
    expect(live.getLatestRun).not.toHaveBeenCalled();
    expect(github.getLatestWorkflowFileRun).not.toHaveBeenCalled();
  });

  it('returns { run: null } when nothing was ever reported and GitHub has nothing', async () => {
    await expect(get()).resolves.toEqual({ run: null });
  });

  it('reads the verify workflow file of the project (suffix from its access workflow) with the app token', async () => {
    await get();
    expect(tokens.installationFirst).toHaveBeenCalledWith('o/r', 'u1', 'oauth');
    expect(github.getLatestWorkflowFileRun).toHaveBeenCalledWith(
      'app-token',
      'o/r',
      '30-alphaci-verify-api.yml',
      'uat',
    );
  });

  it('shows a queued GitHub run as "queued" with no stage', async () => {
    github.getLatestWorkflowFileRun.mockResolvedValue(ghRun());
    const { run } = await get();
    expect(run).toMatchObject({
      runId: 200,
      status: 'queued',
      stage: null,
      total: null,
      done: 0,
      running: [],
      tests: [],
      finishedAt: null,
    });
    expect(github.getWorkflowRunJobs).not.toHaveBeenCalled();
  });

  it('shows an in-progress run with no events as "starting" with the Playwright job\'s current step', async () => {
    github.getLatestWorkflowFileRun.mockResolvedValue(
      ghRun({ status: 'in_progress' }),
    );
    github.getWorkflowRunJobs.mockResolvedValue([
      job('lint', [['Run lint', 'in_progress']]),
      job('Playwright e2e', [
        ['Set up job', 'completed'],
        ['Install Playwright browsers', 'in_progress'],
        ['Run tests', 'queued'],
      ]),
    ]);
    const { run } = await get();
    expect(run).toMatchObject({
      status: 'starting',
      stage: 'Install Playwright browsers',
      startedAt: '2026-10-08T10:00:10.000Z',
    });
  });

  it('is "running" with stage "Running tests" once events exist for the same run', async () => {
    live.getLatestRun.mockResolvedValue(ingested());
    github.getLatestWorkflowFileRun.mockResolvedValue(
      ghRun({ status: 'in_progress' }),
    );
    github.getWorkflowRunJobs.mockResolvedValue([
      job('Playwright e2e', [['Run Playwright tests', 'in_progress']]),
    ]);
    const { run } = await get();
    expect(run).toMatchObject({
      status: 'running',
      stage: 'Running tests',
      done: 1,
      total: 4,
    });
  });

  it('shows a later GitHub step (upload) instead of "Running tests"', async () => {
    live.getLatestRun.mockResolvedValue(ingested());
    github.getLatestWorkflowFileRun.mockResolvedValue(
      ghRun({ status: 'in_progress' }),
    );
    github.getWorkflowRunJobs.mockResolvedValue([
      job('Playwright e2e', [['Upload Playwright report', 'in_progress']]),
    ]);
    expect((await get()).run?.stage).toBe('Upload Playwright report');
  });

  it('uses the reporter outcome when the run finished (cancelled for interrupted)', async () => {
    github.getLatestWorkflowFileRun.mockResolvedValue(
      ghRun({ status: 'completed', conclusion: 'failure' }),
    );
    live.getLatestRun.mockResolvedValue(
      ingested({ status: 'failed', finishedAt: '2026-10-08T10:02:00.000Z' }),
    );
    expect((await get()).run).toMatchObject({
      status: 'failed',
      stage: null,
      finishedAt: '2026-10-08T10:02:00.000Z',
    });

    jest.advanceTimersByTime(PLAYWRIGHT_LIVE_GITHUB_CACHE_MS + 1);
    live.getLatestRun.mockResolvedValue(ingested({ status: 'interrupted' }));
    expect((await get()).run?.status).toBe('cancelled');
  });

  it.each([
    ['success', 'passed'],
    ['failure', 'failed'],
    ['cancelled', 'cancelled'],
    ['timed_out', 'timedout'],
  ])(
    'falls back to the GitHub conclusion %s -> %s when the run died without run_finished',
    async (conclusion, expected) => {
      live.getLatestRun.mockResolvedValue(ingested());
      github.getLatestWorkflowFileRun.mockResolvedValue(
        ghRun({ status: 'completed', conclusion }),
      );
      expect((await get()).run).toMatchObject({
        status: expected,
        stage: null,
        finishedAt: '2026-10-08T10:00:02.000Z',
      });
    },
  );

  it('prefers the newer of (ingested, GitHub) by (runId, attempt)', async () => {
    live.getLatestRun.mockResolvedValue(
      ingested({ runId: 100, status: 'passed', finishedAt: 'x' }),
    );
    github.getLatestWorkflowFileRun.mockResolvedValue(ghRun({ id: 200 }));
    expect((await get()).run).toMatchObject({ runId: 200, status: 'queued' });

    jest.advanceTimersByTime(PLAYWRIGHT_LIVE_GITHUB_CACHE_MS + 1);
    live.getLatestRun.mockResolvedValue(ingested({ runId: 300 }));
    expect((await get()).run).toMatchObject({ runId: 300, status: 'running' });

    // A newer attempt of the same run beats the stored earlier attempt.
    jest.advanceTimersByTime(PLAYWRIGHT_LIVE_GITHUB_CACHE_MS + 1);
    live.getLatestRun.mockResolvedValue(
      ingested({ runId: 200, runAttempt: 1, status: 'failed' }),
    );
    github.getLatestWorkflowFileRun.mockResolvedValue(
      ghRun({ id: 200, runAttempt: 2 }),
    );
    expect((await get()).run).toMatchObject({
      runId: 200,
      runAttempt: 2,
      status: 'queued',
    });
  });

  it('ignores a completed GitHub run that never reported and shows the ingested one', async () => {
    live.getLatestRun.mockResolvedValue(
      ingested({ runId: 100, status: 'passed' }),
    );
    github.getLatestWorkflowFileRun.mockResolvedValue(
      ghRun({ id: 200, status: 'completed', conclusion: 'failure' }),
    );
    expect((await get()).run).toMatchObject({ runId: 100, status: 'passed' });
  });

  it('caches the GitHub reading per repo+branch for a few seconds', async () => {
    github.getLatestWorkflowFileRun.mockResolvedValue(ghRun());
    await get();
    await get();
    await get();
    expect(github.getLatestWorkflowFileRun).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(PLAYWRIGHT_LIVE_GITHUB_CACHE_MS + 1);
    await get();
    expect(github.getLatestWorkflowFileRun).toHaveBeenCalledTimes(2);

    await service.getLive('p1', 'u1', 'oauth', 'main');
    expect(github.getLatestWorkflowFileRun).toHaveBeenCalledTimes(3);
  });

  it('falls back to ingested data when GitHub cannot be read, and does not hammer it', async () => {
    live.getLatestRun.mockResolvedValue(ingested());
    github.getLatestWorkflowFileRun.mockRejectedValue(
      new Error('rate limited'),
    );
    const warn = jest
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => undefined);

    expect((await get()).run).toMatchObject({
      status: 'running',
      stage: 'Running tests',
    });
    await get();
    expect(github.getLatestWorkflowFileRun).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rate limited'));
  });

  it('falls back when the job list fails or no GitHub token resolves', async () => {
    live.getLatestRun.mockResolvedValue(ingested());
    github.getLatestWorkflowFileRun.mockResolvedValue(
      ghRun({ status: 'in_progress' }),
    );
    github.getWorkflowRunJobs.mockRejectedValue(new Error('502'));
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    expect((await get()).run?.status).toBe('running');

    jest.advanceTimersByTime(PLAYWRIGHT_LIVE_GITHUB_CACHE_MS + 1);
    tokens.installationFirst.mockResolvedValue(null);
    github.getLatestWorkflowFileRun.mockClear();
    expect((await get()).run?.status).toBe('running');
    expect(github.getLatestWorkflowFileRun).not.toHaveBeenCalled();
  });
});
