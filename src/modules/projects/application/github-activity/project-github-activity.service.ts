import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import {
  AUDIT_EXTERNAL_INGEST_PORT,
  type AuditExternalIngestPort,
  type ExternalAuditEvent,
} from '#kernel/ports/audit.port';
import {
  GITHUB_PROJECT_PORT,
  type GitHubPullRequestHeadline,
  type GitHubPushCommits,
  type GitHubRepositoryEvent,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import {
  ProjectsRepository,
  type ProvisionedProjectRow,
} from '../../infrastructure/projects.repository';
import type { ProjectGithubSyncStatus } from '../lifecycle/projects.service.types';
import {
  isRelevantGithubEvent,
  mapGithubEvent,
  pullRequestNumberOf,
  pushNeedsCompare,
} from './github-activity.mapper';
import { ProjectGithubTokenResolver } from './project-github-token.resolver';

/** A repository is re-read from GitHub at most this often. */
export const GITHUB_SYNC_MIN_INTERVAL_MS = 60_000;
/** An Audit page waits this long for GitHub before returning stored events. */
export const GITHUB_SYNC_BUDGET_MS = 3_000;
/** A forced sync (POST) may wait longer than an Audit page view. */
const FORCED_SYNC_BUDGET_MS = 10_000;
/** Cap on per-sync detail lookups (compare / pull request) so one sync stays cheap. */
const MAX_ENRICHMENT_CALLS = 15;
const ENRICHMENT_CONCURRENCY = 5;

export interface GithubSyncResult extends ProjectGithubSyncStatus {
  /** Rows newly stored by this sync; null while it is still running. */
  ingested: number | null;
}

interface SyncRun {
  promise: Promise<number>;
}

/**
 * Brings a repository's GitHub activity into its Audit trail.
 *
 * WHY POLLING. The GitHub App's webhooks do not reach the backend (zero
 * deliveries have ever been recorded), so nothing is pushed to us; the Events
 * API is read instead. It keeps the last 90 days / 300 events per repository
 * and supports ETags, so an unchanged repository costs one 304.
 *
 * THROTTLE. The last successful sync (time + ETag) is stored per repository in
 * audit.github_event_syncs via the audit ingest port, so the 60 second window
 * holds across backend instances. Two in-memory structures cover what the table
 * cannot, both per process and both lost on restart (harmless: the worst case
 * is one extra conditional GET):
 *   - `running`  coalesces concurrent syncs of one repository into one run;
 *   - `failures` remembers a failed attempt for the same 60 seconds so a
 *     repository GitHub cannot serve (revoked sign-in, no token, outage) is not
 *     hammered by every Audit page view.
 *
 * BOUNDED TIME. A sync that outlasts the budget is NOT cancelled: the page is
 * answered from stored events with status 'stale' and the run finishes in the
 * background, so the next view has the data.
 */
@Injectable()
export class ProjectGithubActivityService {
  private readonly logger = new Logger(ProjectGithubActivityService.name);
  private readonly running = new Map<string, SyncRun>();
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly projectsRepository: ProjectsRepository,
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
    private readonly tokens: ProjectGithubTokenResolver,
    @Optional()
    @Inject(AUDIT_EXTERNAL_INGEST_PORT)
    private readonly ingest?: AuditExternalIngestPort,
  ) {}

  /** Whether syncing is possible at all (recording on, audit module wired). */
  isEnabled(): boolean {
    return this.ingest?.isRecording() === true;
  }

  /**
   * POST /projects/:id/audit/sync — any member who can see the repository may
   * force a sync (404 otherwise). Ignores the 60 second throttle and waits
   * longer than an Audit page view does.
   */
  async syncProject(
    projectId: string,
    userId: string,
    oauthToken: string | null,
  ): Promise<
    GithubSyncResult | { status: 'disabled'; syncedAt: null; ingested: 0 }
  > {
    const project = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    const result = await this.syncIfDue(project, userId, oauthToken, {
      force: true,
      budgetMs: FORCED_SYNC_BUDGET_MS,
    });
    // null = audit recording is off: nothing is read or stored.
    return result ?? { status: 'disabled', syncedAt: null, ingested: 0 };
  }

  /**
   * Sync `project` unless it was synced within the last minute.
   * Returns null when recording is off (nothing is read or stored).
   * Never throws: GitHub trouble is reported as `status`.
   */
  async syncIfDue(
    project: ProvisionedProjectRow,
    userId: string,
    oauthToken: string | null,
    options: { force?: boolean; budgetMs?: number } = {},
  ): Promise<GithubSyncResult | null> {
    const ingest = this.ingest;
    if (!ingest?.isRecording()) {
      return null;
    }
    const repo = project.repo_full_name.toLowerCase();
    const budgetMs = options.budgetMs ?? GITHUB_SYNC_BUDGET_MS;

    let state: Awaited<
      ReturnType<AuditExternalIngestPort['getGithubSyncState']>
    >;
    try {
      state = await ingest.getGithubSyncState(repo);
    } catch (error) {
      this.logger.warn(
        `Could not read the GitHub sync state of ${repo}: ${String(error)}`,
      );
      return { status: 'failed', syncedAt: null, ingested: null };
    }
    const syncedAt = state?.syncedAt ?? null;

    if (!options.force) {
      if (
        syncedAt !== null &&
        Date.now() - Date.parse(syncedAt) < GITHUB_SYNC_MIN_INTERVAL_MS
      ) {
        return { status: 'ok', syncedAt, ingested: 0 };
      }
      const failedAt = this.failures.get(repo);
      if (
        failedAt !== undefined &&
        Date.now() - failedAt < GITHUB_SYNC_MIN_INTERVAL_MS
      ) {
        return { status: 'failed', syncedAt, ingested: 0 };
      }
    }

    const run = this.start(
      repo,
      project,
      userId,
      oauthToken,
      state?.etag ?? null,
    );

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), budgetMs);
    });
    try {
      const outcome = await Promise.race([run.promise, timeout]);
      if (outcome === 'timeout') {
        return { status: 'stale', syncedAt, ingested: null };
      }
      return {
        status: 'ok',
        syncedAt: new Date().toISOString(),
        ingested: outcome,
      };
    } catch {
      // Already logged and remembered by start().
      return { status: 'failed', syncedAt, ingested: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  private start(
    repo: string,
    project: ProvisionedProjectRow,
    userId: string,
    oauthToken: string | null,
    etag: string | null,
  ): SyncRun {
    const existing = this.running.get(repo);
    if (existing) {
      return existing;
    }
    const promise = this.sync(repo, project, userId, oauthToken, etag).finally(
      () => {
        this.running.delete(repo);
      },
    );
    // Bookkeeping lives with the run, not the request: a run that outlives its
    // request (status 'stale') still clears or sets the failure memory, and
    // never becomes an unhandled rejection.
    promise.then(
      () => {
        this.failures.delete(repo);
      },
      (error: unknown) => {
        this.failures.set(repo, Date.now());
        this.logger.warn(
          `GitHub activity sync of ${repo} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
    const run = { promise };
    this.running.set(repo, run);
    return run;
  }

  private async sync(
    repo: string,
    project: ProvisionedProjectRow,
    userId: string,
    oauthToken: string | null,
    etag: string | null,
  ): Promise<number> {
    const ingest = this.ingest;
    if (!ingest) return 0;

    const token = await this.tokens.installationFirst(
      project.repo_full_name,
      userId,
      oauthToken,
    );
    if (!token) {
      throw new Error('No usable GitHub token for this repository');
    }

    const result = await this.githubService.listRepositoryEvents(
      token,
      project.repo_full_name,
      { etag },
    );
    if (result.status === 'not_modified') {
      await ingest.saveGithubSyncState(repo, {
        etag,
        syncedAt: new Date().toISOString(),
      });
      return 0;
    }

    const relevant = result.events.filter(isRelevantGithubEvent);
    const unrecorded = await ingest.findUnrecordedExternalIds(
      relevant.map((event) => `github:${event.id}`),
    );
    const fresh = relevant.filter((event) =>
      unrecorded.has(`github:${event.id}`),
    );

    const enrichment = await this.enrich(token, project.repo_full_name, fresh);
    const mapped: ExternalAuditEvent[] = [];
    for (const event of fresh) {
      const prNumber = pullRequestNumberOf(event);
      const item = mapGithubEvent(event, project.repo_full_name, {
        push: enrichment.pushes.get(event.id) ?? null,
        pullRequest:
          prNumber === null ? null : (enrichment.pulls.get(prNumber) ?? null),
      });
      if (item) mapped.push(item);
    }

    const { inserted } = await ingest.ingestExternalEvents({
      projectId: project.id,
      workspaceId: project.workspace_id ?? null,
      events: mapped,
    });
    // Saved last: a sync that died before this point is retried from the old
    // ETag, and the unique external_id makes the retry safe.
    await ingest.saveGithubSyncState(repo, {
      etag: result.etag,
      syncedAt: new Date().toISOString(),
    });
    return inserted;
  }

  /**
   * GitHub's push events no longer list commits and its pull request events no
   * longer carry a title, so the newest un-ingested ones are looked up
   * (compare, pull request). Capped; a failed lookup just leaves that event
   * with a less specific message. Events already stored are never looked up
   * again, which is what keeps a steady-state sync at zero extra calls.
   */
  private async enrich(
    token: string,
    repoFullName: string,
    fresh: GitHubRepositoryEvent[],
  ): Promise<{
    pushes: Map<string, GitHubPushCommits>;
    pulls: Map<number, GitHubPullRequestHeadline>;
  }> {
    const pushes = new Map<string, GitHubPushCommits>();
    const pulls = new Map<number, GitHubPullRequestHeadline>();

    // Events arrive newest first; the newest ones matter most.
    const jobs: Array<() => Promise<void>> = [];
    const seenPulls = new Set<number>();
    for (const event of fresh) {
      if (jobs.length >= MAX_ENRICHMENT_CALLS) break;
      if (pushNeedsCompare(event)) {
        const before = event.payload['before'] as string;
        const head = event.payload['head'] as string;
        jobs.push(async () => {
          const compared = await this.githubService.compareCommits(
            token,
            repoFullName,
            before,
            head,
          );
          if (compared) pushes.set(event.id, compared);
        });
      }
      const number = pullRequestNumberOf(event);
      if (number !== null && !seenPulls.has(number)) {
        seenPulls.add(number);
        jobs.push(async () => {
          const headline = await this.githubService.getPullRequestHeadline(
            token,
            repoFullName,
            number,
          );
          if (headline) pulls.set(number, headline);
        });
      }
    }

    for (let i = 0; i < jobs.length; i += ENRICHMENT_CONCURRENCY) {
      await Promise.allSettled(
        jobs.slice(i, i + ENRICHMENT_CONCURRENCY).map((job) => job()),
      );
    }
    return { pushes, pulls };
  }
}
