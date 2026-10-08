import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import {
  GITHUB_PROJECT_PORT,
  type GitHubRunJob,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import {
  PLAYWRIGHT_LIVE_PORT,
  type PlaywrightLiveFinishedTest,
  type PlaywrightLivePort,
  type PlaywrightLiveRunFacts,
  type PlaywrightLiveRunningTest,
} from '#kernel/ports/playwright-live.port';
import { ProjectGithubTokenResolver } from '../github-activity/project-github-token.resolver';
import { ProjectsRepository } from '../../infrastructure/projects.repository';
import { resolveVerifyWorkflowFile } from '../qa-runs/resolve-verify-workflow-file';

/** The branches the Playwright tab can show (QA Studio runs on uat). */
export type PlaywrightLiveBranch = 'uat' | 'main';

export type PlaywrightLiveStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'timedout';

export interface PlaywrightLiveRun {
  runId: number;
  runAttempt: number;
  commitSha: string;
  branch: string;
  status: PlaywrightLiveStatus;
  /** Human step name: GitHub's in-progress step before tests start, "Running tests" while they run. */
  stage: string | null;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  total: number | null;
  done: number;
  passed: number;
  failed: number;
  skipped: number;
  running: PlaywrightLiveRunningTest[];
  tests: PlaywrightLiveFinishedTest[];
}

export interface PlaywrightLiveResponse {
  run: PlaywrightLiveRun | null;
}

/** What one GitHub reading of the verify workflow's newest run came to. */
interface GithubReading {
  runId: number;
  runAttempt: number;
  commitSha: string;
  /** Not completed: queued or in progress. */
  active: boolean;
  inProgress: boolean;
  conclusion: string | null;
  stage: string | null;
  startedAt: string | null;
  updatedAt: string;
}

/** How long one repository+branch GitHub reading is reused (the tab polls every ~3 s). */
export const PLAYWRIGHT_LIVE_GITHUB_CACHE_MS = 4_000;

/** Steps after the tests themselves; while one is running the tab shows its name. */
const POST_TEST_STEP = /upload|publish|report|artifact|post |summary/i;
const PLAYWRIGHT_JOB = /playwright|e2e|browser/i;
const RUNNING_STAGE = 'Running tests';

/**
 * The studio's live Playwright tab: ingested test-by-test progress (Pipelines,
 * through PLAYWRIGHT_LIVE_PORT) combined with what GitHub says about the
 * verify workflow's newest run, so the tab shows "Queued" / "Starting" with
 * the current step before the first event arrives.
 *
 * Access is project visibility (a project the caller cannot see is a 404).
 * GitHub is best effort: any failure reading it falls back to ingested data.
 */
@Injectable()
export class ProjectPlaywrightLiveService {
  private readonly logger = new Logger(ProjectPlaywrightLiveService.name);
  private readonly cache = new Map<
    string,
    { at: number; reading: Promise<GithubReading | null> }
  >();

  constructor(
    private readonly projectsRepository: ProjectsRepository,
    @Inject(PLAYWRIGHT_LIVE_PORT)
    private readonly live: PlaywrightLivePort,
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
    private readonly tokens: ProjectGithubTokenResolver,
  ) {}

  async getLive(
    projectId: string,
    userId: string,
    oauthToken: string | null,
    branch: PlaywrightLiveBranch,
  ): Promise<PlaywrightLiveResponse> {
    const project = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const [ingested, github] = await Promise.all([
      this.live.getLatestRun(project.repo_full_name, branch),
      this.readGithub(
        project.repo_full_name,
        branch,
        resolveVerifyWorkflowFile(project.workflow_path),
        userId,
        oauthToken,
      ),
    ]);
    return { run: this.compose(branch, ingested, github) };
  }

  // ─── Choosing and merging ────────────────────────────────────────────────

  private compose(
    branch: string,
    ingested: PlaywrightLiveRunFacts | null,
    github: GithubReading | null,
  ): PlaywrightLiveRun | null {
    // A GitHub run that has not reported yet and is newer than anything
    // ingested is "the run": queued or starting.
    if (github?.active && (!ingested || compareRuns(github, ingested) > 0)) {
      return {
        runId: github.runId,
        runAttempt: github.runAttempt,
        commitSha: github.commitSha,
        branch,
        status: github.inProgress ? 'starting' : 'queued',
        stage: github.stage,
        startedAt: github.startedAt,
        updatedAt: github.updatedAt,
        finishedAt: null,
        total: null,
        done: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        running: [],
        tests: [],
      };
    }
    if (!ingested) return null;

    const same =
      github !== null && compareRuns(github, ingested) === 0 ? github : null;
    let status: PlaywrightLiveStatus;
    let stage: string | null = null;
    let finishedAt = ingested.finishedAt;

    if (ingested.status === 'running') {
      if (same && !same.active) {
        // The workflow ended without a run_finished event (crash, cancel).
        status = fromConclusion(same.conclusion);
        finishedAt = same.updatedAt;
      } else {
        status = 'running';
        stage =
          same?.stage && POST_TEST_STEP.test(same.stage)
            ? same.stage
            : RUNNING_STAGE;
      }
    } else {
      status =
        ingested.status === 'interrupted' ? 'cancelled' : ingested.status;
      stage = same?.active ? same.stage : null;
    }

    return {
      runId: ingested.runId,
      runAttempt: ingested.runAttempt,
      commitSha: ingested.commitSha,
      branch: ingested.branch,
      status,
      stage,
      startedAt: ingested.startedAt,
      updatedAt: ingested.updatedAt,
      finishedAt,
      total: ingested.total,
      done: ingested.done,
      passed: ingested.passed,
      failed: ingested.failed,
      skipped: ingested.skipped,
      running: ingested.running,
      tests: ingested.tests,
    };
  }

  // ─── GitHub (cached, never throws) ───────────────────────────────────────

  private readGithub(
    repoFullName: string,
    branch: string,
    workflowFile: string,
    userId: string,
    oauthToken: string | null,
  ): Promise<GithubReading | null> {
    const key = `${repoFullName.toLowerCase()}|${branch}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < PLAYWRIGHT_LIVE_GITHUB_CACHE_MS) {
      return cached.reading;
    }
    const reading = this.readGithubFresh(
      repoFullName,
      branch,
      workflowFile,
      userId,
      oauthToken,
    );
    this.cache.set(key, { at: Date.now(), reading });
    this.evictExpired();
    return reading;
  }

  private evictExpired(): void {
    if (this.cache.size < 200) return;
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.at >= PLAYWRIGHT_LIVE_GITHUB_CACHE_MS) {
        this.cache.delete(key);
      }
    }
  }

  private async readGithubFresh(
    repoFullName: string,
    branch: string,
    workflowFile: string,
    userId: string,
    oauthToken: string | null,
  ): Promise<GithubReading | null> {
    try {
      const token = await this.tokens.installationFirst(
        repoFullName,
        userId,
        oauthToken,
      );
      if (!token) return null;

      const run = await this.githubService.getLatestWorkflowFileRun(
        token,
        repoFullName,
        workflowFile,
        branch,
      );
      if (!run) return null;

      const active = run.status !== 'completed';
      const inProgress = run.status === 'in_progress';
      let stage: string | null = null;
      let startedAt: string | null = null;
      if (inProgress) {
        const jobs = await this.githubService.getWorkflowRunJobs(
          token,
          repoFullName,
          run.id,
        );
        ({ stage, startedAt } = pickStage(jobs));
      }
      return {
        runId: run.id,
        runAttempt: run.runAttempt,
        commitSha: run.headSha,
        active,
        inProgress,
        conclusion: run.conclusion,
        stage,
        startedAt: startedAt ?? (inProgress ? run.createdAt : null),
        updatedAt: run.updatedAt,
      };
    } catch (error) {
      this.logger.warn(
        `Could not read the ${workflowFile} run of ${repoFullName}@${branch}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}

function compareRuns(
  a: { runId: number; runAttempt: number },
  b: { runId: number; runAttempt: number },
): number {
  return a.runId !== b.runId ? a.runId - b.runId : a.runAttempt - b.runAttempt;
}

function fromConclusion(conclusion: string | null): PlaywrightLiveStatus {
  switch (conclusion) {
    case 'success':
      return 'passed';
    case 'cancelled':
    case 'skipped':
      return 'cancelled';
    case 'timed_out':
      return 'timedout';
    default:
      return 'failed';
  }
}

/** The in-progress step of the Playwright job (else of the first running job). */
function pickStage(jobs: GitHubRunJob[]): {
  stage: string | null;
  startedAt: string | null;
} {
  const running = jobs.filter((job) => job.status === 'in_progress');
  const job =
    running.find((candidate) => PLAYWRIGHT_JOB.test(candidate.name)) ??
    running[0];
  if (!job) return { stage: null, startedAt: null };
  const step = job.steps
    .filter((candidate) => candidate.status === 'in_progress')
    .sort((a, b) => a.number - b.number)[0];
  return { stage: step?.name ?? null, startedAt: job.startedAt };
}
