import type {
  GitHubPullRequestHeadline,
  GitHubPushCommits,
  GitHubRepositoryEvent,
} from '#kernel/ports/github.port';
import type { ExternalAuditEvent } from '#kernel/ports/audit.port';

/**
 * GitHub repository event -> audit row.
 *
 * Pure: no I/O, so every mapping is unit-testable. GitHub's Events API no
 * longer carries commit lists (PushEvent) or titles (PullRequestEvent), so the
 * caller may pass what it could fetch separately (`enrichment`); an event
 * maps fine without it, just with a less specific message.
 *
 * Event codes (all prefixed `github.`):
 *   github.push                       PushEvent to a branch
 *   github.pull_request.opened|merged|closed|reopened
 *   github.pull_request.reviewed      PullRequestReviewEvent (submitted)
 *   github.branch.created|deleted     CreateEvent / DeleteEvent, ref_type branch
 *   github.tag.created|deleted        CreateEvent / DeleteEvent, ref_type tag
 * Everything else (issue comments, forks, stars, ...) is ignored.
 */

export const MAX_PUSH_COMMITS = 20;
const ZERO_SHA = /^0+$/;

export interface GithubEventEnrichment {
  push?: GitHubPushCommits | null;
  pullRequest?: GitHubPullRequestHeadline | null;
}

const RELEVANT_TYPES = new Set([
  'PushEvent',
  'PullRequestEvent',
  'PullRequestReviewEvent',
  'CreateEvent',
  'DeleteEvent',
]);

export function isRelevantGithubEvent(event: GitHubRepositoryEvent): boolean {
  if (!RELEVANT_TYPES.has(event.type)) return false;
  return mapGithubEvent(event, 'x/y') !== null;
}

/** Fully qualified `refs/heads/dev` -> `dev`; null for anything else. */
function branchOf(ref: unknown): string | null {
  return typeof ref === 'string' && ref.startsWith('refs/heads/')
    ? ref.slice('refs/heads/'.length)
    : null;
}

function firstLine(message: string): string {
  return (message.split(/\r?\n/, 1)[0] ?? '').slice(0, 200);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** Whether a push needs the compare call that reveals its commits. */
export function pushNeedsCompare(event: GitHubRepositoryEvent): boolean {
  if (event.type !== 'PushEvent') return false;
  const payload = event.payload;
  const before = str(payload['before']);
  const head = str(payload['head']);
  return (
    branchOf(payload['ref']) !== null &&
    before !== null &&
    head !== null &&
    !ZERO_SHA.test(before)
  );
}

/** The pull request number a PR/review event is about, if it names one. */
export function pullRequestNumberOf(
  event: GitHubRepositoryEvent,
): number | null {
  if (event.type !== 'PullRequestEvent') return null;
  return (
    num(event.payload['number']) ??
    num(record(event.payload['pull_request'])['number'])
  );
}

export function mapGithubEvent(
  event: GitHubRepositoryEvent,
  repoFullName: string,
  enrichment: GithubEventEnrichment = {},
): ExternalAuditEvent | null {
  const mapped = mapBody(event, repoFullName, enrichment);
  if (!mapped) return null;
  const login = event.actor?.login ?? null;
  return {
    externalId: `github:${event.id}`,
    eventCode: mapped.eventCode,
    message: mapped.message,
    metadata: { ...mapped.metadata, githubLogin: login },
    actorLogin: login,
    occurredAt: event.createdAt,
  };
}

interface MappedBody {
  eventCode: string;
  message: string;
  metadata: Record<string, unknown>;
}

function mapBody(
  event: GitHubRepositoryEvent,
  repoFullName: string,
  enrichment: GithubEventEnrichment,
): MappedBody | null {
  const payload = event.payload;
  const repoUrl = `https://github.com/${repoFullName}`;

  switch (event.type) {
    case 'PushEvent': {
      const branch = branchOf(payload['ref']);
      // Tag pushes are reported by the CreateEvent for the tag.
      if (!branch) return null;
      const before = str(payload['before']);
      const head = str(payload['head']);
      const compared = enrichment.push ?? null;
      const size = compared?.totalCommits ?? num(payload['size']);
      const commits = (compared?.commits ?? [])
        .slice(0, MAX_PUSH_COMMITS)
        .map((commit) => ({
          sha: commit.sha,
          message: firstLine(commit.message),
          authorName: commit.authorName,
        }));
      // A compare that does not end ahead means the old head is no ancestor of
      // the new one: the branch was rewritten.
      const forced =
        compared !== null &&
        compared.status !== 'ahead' &&
        compared.status !== 'identical';
      const created = before !== null && ZERO_SHA.test(before);
      return {
        eventCode: 'github.push',
        message: `${forced ? 'Force-pushed' : 'Pushed'}${
          size === null
            ? ''
            : ` ${String(size)} ${size === 1 ? 'commit' : 'commits'}`
        } to ${branch}`,
        metadata: {
          branch,
          before,
          head,
          size,
          commits,
          forced,
          url:
            before && head && !created
              ? `${repoUrl}/compare/${before}...${head}`
              : head
                ? `${repoUrl}/commit/${head}`
                : repoUrl,
        },
      };
    }

    case 'PullRequestEvent': {
      const number = pullRequestNumberOf(event);
      if (number === null) return null;
      const action = str(payload['action']);
      const pr = record(payload['pull_request']);
      const info = enrichment.pullRequest ?? null;
      let kind: 'opened' | 'merged' | 'closed' | 'reopened';
      if (action === 'opened' || action === 'reopened') {
        kind = action;
      } else if (action === 'merged') {
        kind = 'merged';
      } else if (action === 'closed') {
        kind =
          info?.merged === true || pr['merged'] === true ? 'merged' : 'closed';
      } else {
        return null;
      }
      const base = str(record(pr['base'])['ref']);
      const head = str(record(pr['head'])['ref']);
      const title = info?.title || str(pr['title']);
      const verb = {
        opened: 'Opened',
        merged: 'Merged',
        closed: 'Closed',
        reopened: 'Reopened',
      }[kind];
      return {
        eventCode: `github.pull_request.${kind}`,
        message: `${verb} pull request #${String(number)}${title ? ` "${title}"` : ''}${
          base && head ? ` (${head} into ${base})` : ''
        }`,
        metadata: {
          number,
          title: title ?? null,
          base,
          head,
          url: `${repoUrl}/pull/${String(number)}`,
          merged_by: kind === 'merged' ? (info?.mergedByLogin ?? null) : null,
        },
      };
    }

    case 'PullRequestReviewEvent': {
      const action = str(payload['action']);
      if (action !== 'submitted' && action !== 'created') return null;
      const pr = record(payload['pull_request']);
      const number = num(pr['number']) ?? num(payload['number']);
      if (number === null) return null;
      const state = str(record(payload['review'])['state'])?.toLowerCase();
      return {
        eventCode: 'github.pull_request.reviewed',
        message: `Reviewed pull request #${String(number)}${
          state ? ` (${state.replace(/_/g, ' ')})` : ''
        }`,
        metadata: {
          number,
          state: state ?? null,
          url: `${repoUrl}/pull/${String(number)}`,
        },
      };
    }

    case 'CreateEvent':
    case 'DeleteEvent': {
      const refType = str(payload['ref_type']);
      const ref = str(payload['ref']);
      if ((refType !== 'branch' && refType !== 'tag') || !ref) return null;
      const created = event.type === 'CreateEvent';
      return {
        eventCode: `github.${refType}.${created ? 'created' : 'deleted'}`,
        message: `${created ? 'Created' : 'Deleted'} ${refType} ${ref}`,
        metadata: {
          ref,
          refType,
          url: created
            ? `${repoUrl}/tree/${ref}`
            : `${repoUrl}/${refType === 'tag' ? 'tags' : 'branches'}`,
        },
      };
    }

    default:
      return null;
  }
}
