import { BadGatewayException, UnauthorizedException } from '@nestjs/common';

import type {
  GitHubCommitListQuery,
  GitHubCommitPage,
  GitHubPullRequestHeadline,
  GitHubPushCommits,
  GitHubRepositoryEvent,
  GitHubRepositoryEventsResult,
} from '#kernel/ports/github.port';
import type { GithubHttp } from './github-http';
import { userWriteRefusal } from './github-workspace.mapping';

/** GitHub keeps at most 300 events (3 pages of 100) for 90 days. */
const EVENTS_PER_PAGE = 100;
const EVENTS_MAX_PAGES = 3;

interface CommitRow {
  sha: string;
  html_url?: string;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string } | null;
    committer?: { name?: string; date?: string } | null;
  };
  author?: { login?: string } | null;
}

interface EventRow {
  id: string;
  type: string;
  actor?: { login?: string } | null;
  created_at?: string;
  payload?: Record<string, unknown>;
}

/**
 * GitHub reads behind the commits list and the Audit trail's GitHub activity.
 * Kept apart from GithubService (already the largest file in the product)
 * because none of it shares state with provisioning.
 */
export class GithubActivityClient {
  constructor(private readonly http: GithubHttp) {}

  async listCommits(
    accessToken: string,
    repoFullName: string,
    query: GitHubCommitListQuery,
  ): Promise<GitHubCommitPage> {
    const params = new URLSearchParams({
      sha: query.branch,
      per_page: String(query.perPage),
      page: String(query.page),
    });
    const response = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${repoFullName}/commits?${params.toString()}`,
      { headers: this.http.workspaceHeaders(accessToken) },
    );

    // 404 (branch or repository not visible) and 409 (empty repository) are
    // normal states of a browsing UI: an empty list, not an error banner.
    if (response.status === 404 || response.status === 409) {
      return { items: [], hasNextPage: false };
    }
    const refusal =
      response.status === 401
        ? userWriteRefusal(401, false, repoFullName)
        : null;
    if (refusal) {
      throw new UnauthorizedException(refusal);
    }
    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub commit list failed (${String(response.status)}): ${body.slice(0, 300)}`,
      );
    }

    const rows = (await response.json()) as CommitRow[];
    const link = response.headers?.get('link') ?? '';
    return {
      items: rows.map((row) => ({
        sha: row.sha,
        message: row.commit?.message ?? '',
        authorLogin: row.author?.login ?? null,
        authorName:
          row.commit?.author?.name ?? row.commit?.committer?.name ?? '',
        authoredAt:
          row.commit?.author?.date ?? row.commit?.committer?.date ?? '',
        url: row.html_url ?? '',
      })),
      hasNextPage: /rel="next"/.test(link),
    };
  }

  async listRepositoryEvents(
    accessToken: string,
    repoFullName: string,
    options: { etag?: string | null } = {},
  ): Promise<GitHubRepositoryEventsResult> {
    const headers = this.http.workspaceHeaders(accessToken);
    const first = await this.http.fetchWithRetry(
      this.eventsUrl(repoFullName, 1),
      {
        headers: options.etag
          ? { ...headers, 'If-None-Match': options.etag }
          : headers,
      },
    );
    if (first.status === 304) {
      return { status: 'not_modified' };
    }
    await this.assertEventsOk(first, repoFullName);

    const events: EventRow[] = (await first.json()) as EventRow[];
    let more = /rel="next"/.test(first.headers?.get('link') ?? '');
    for (let page = 2; more && page <= EVENTS_MAX_PAGES; page += 1) {
      const next = await this.http.fetchWithRetry(
        this.eventsUrl(repoFullName, page),
        { headers },
      );
      await this.assertEventsOk(next, repoFullName);
      events.push(...((await next.json()) as EventRow[]));
      more = /rel="next"/.test(next.headers?.get('link') ?? '');
    }

    return {
      status: 'modified',
      etag: first.headers?.get('etag') ?? null,
      events: events.map(
        (row): GitHubRepositoryEvent => ({
          id: String(row.id),
          type: row.type,
          actor: row.actor?.login ? { login: row.actor.login } : null,
          createdAt: row.created_at ?? new Date().toISOString(),
          payload: row.payload ?? {},
        }),
      ),
    };
  }

  async compareCommits(
    accessToken: string,
    repoFullName: string,
    base: string,
    head: string,
    limit = 20,
  ): Promise<GitHubPushCommits | null> {
    const payload = await this.http.workspaceGet<{
      status?: string;
      total_commits?: number;
      commits?: Array<{
        sha: string;
        commit?: { message?: string; author?: { name?: string } | null };
      }>;
    }>(
      `https://api.github.com/repos/${repoFullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=${String(limit)}`,
      accessToken,
      'push comparison',
    );
    if (!payload) return null;
    const commits = (payload.commits ?? []).slice(0, limit).map((c) => ({
      sha: c.sha,
      message: c.commit?.message ?? '',
      authorName: c.commit?.author?.name ?? '',
    }));
    return {
      status: payload.status ?? 'ahead',
      totalCommits: payload.total_commits ?? commits.length,
      commits,
    };
  }

  async getPullRequestHeadline(
    accessToken: string,
    repoFullName: string,
    pullNumber: number,
  ): Promise<GitHubPullRequestHeadline | null> {
    const payload = await this.http.workspaceGet<{
      title?: string;
      merged?: boolean;
      merged_by?: { login?: string } | null;
      html_url?: string;
    }>(
      `https://api.github.com/repos/${repoFullName}/pulls/${String(pullNumber)}`,
      accessToken,
      'pull request headline',
    );
    if (!payload) return null;
    return {
      title: payload.title ?? '',
      merged: payload.merged === true,
      mergedByLogin: payload.merged_by?.login ?? null,
      htmlUrl: payload.html_url ?? '',
    };
  }

  private eventsUrl(repoFullName: string, page: number): string {
    return `https://api.github.com/repos/${repoFullName}/events?per_page=${String(EVENTS_PER_PAGE)}&page=${String(page)}`;
  }

  private async assertEventsOk(
    response: Awaited<ReturnType<GithubHttp['fetchWithRetry']>>,
    repoFullName: string,
  ): Promise<void> {
    if (response.ok) return;
    if (response.status === 401) {
      throw new UnauthorizedException(
        userWriteRefusal(401, false, repoFullName) ??
          'GitHub no longer accepts this sign-in.',
      );
    }
    const body = await response.text();
    throw new BadGatewayException(
      `GitHub repository events failed (${String(response.status)}): ${body.slice(0, 300)}`,
    );
  }
}
