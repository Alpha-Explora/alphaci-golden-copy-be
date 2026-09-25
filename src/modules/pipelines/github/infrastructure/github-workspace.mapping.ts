import type {
  GitHubContentEntry,
  GitHubContentEntryType,
  GitHubContentListing,
  GitHubPullRequestFile,
  GitHubPullRequestDetail,
  GitHubPullRequestSummary,
} from './github-workspace.types';
import type {
  GitHubBranchComparison,
  GitHubComparisonCommit,
} from '#kernel/ports/github.port';

/** Max bytes of a blob we will decode and send to a browser. */
export const MAX_FILE_BYTES = 512 * 1024;

/**
 * Raw GitHub REST contents row, declared only as far as workspace reads
 * consume it. Every field is optional: these describe someone else's API,
 * and a missing key must fall back rather than throw.
 */
export interface GitHubContentsRow {
  name?: string;
  path?: string;
  type?: string;
  size?: number;
  sha?: string;
  content?: string;
  encoding?: string;
  html_url?: string;
}

function toContentEntry(row: GitHubContentsRow): GitHubContentEntry {
  return {
    name: row.name ?? '',
    path: row.path ?? '',
    type: (row.type ?? 'file') as GitHubContentEntryType,
    size: row.size ?? 0,
    sha: row.sha ?? '',
  };
}

function compareContentEntries(
  a: GitHubContentEntry,
  b: GitHubContentEntry,
): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Directory listing from GitHub's contents API. Directories first, then
 * alphabetical — the ordering every file browser uses, and one GitHub does
 * not guarantee.
 */
export function mapContentEntries(
  payload: readonly GitHubContentsRow[],
): GitHubContentEntry[] {
  return payload.map(toContentEntry).sort(compareContentEntries);
}

/**
 * One file from GitHub's contents API.
 *
 * A binary blob or an oversized file is reported as truncated rather than
 * decoded: turning a PNG into a UTF-8 string produces a screenful of
 * replacement characters, which reads as corruption rather than as "this is
 * not text". The NUL-byte probe is the same heuristic git itself uses.
 */
export function toFileListing(
  row: GitHubContentsRow,
  cleanPath: string,
  ref: string,
): GitHubContentListing {
  const size = row.size ?? 0;
  const tooLarge = size > MAX_FILE_BYTES;
  const decoded =
    !tooLarge && row.content && row.encoding === 'base64'
      ? Buffer.from(row.content, 'base64')
      : null;
  const isText = decoded !== null && !decoded.includes(0);

  return {
    path: row.path ?? cleanPath,
    ref,
    entries: [],
    file: {
      name: row.name ?? cleanPath,
      path: row.path ?? cleanPath,
      size,
      sha: row.sha ?? '',
      content: isText && decoded ? decoded.toString('utf8') : null,
      truncated: tooLarge || !isText,
      htmlUrl: row.html_url ?? null,
    },
  };
}

/**
 * Raw GitHub REST pull-request row, declared only as far as workspace reads
 * consume it. Every field except `number` is optional: these describe someone
 * else's API, and a missing key must fall back rather than throw.
 */
export interface GitHubPullRequestRow {
  number: number;
  title?: string;
  state?: string;
  draft?: boolean;
  merged_at?: string | null;
  html_url?: string;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
  body?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  user?: { login?: string; avatar_url?: string };
  created_at?: string;
  updated_at?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

export interface GitHubPullRequestFileRow {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
}

export function toPullRequestSummary(
  pr: GitHubPullRequestRow,
): GitHubPullRequestSummary {
  return {
    number: pr.number,
    title: pr.title ?? '',
    state: pr.state === 'closed' ? 'closed' : 'open',
    draft: pr.draft === true,
    merged: pr.merged_at != null,
    htmlUrl: pr.html_url ?? '',
    headRef: pr.head?.ref ?? '',
    baseRef: pr.base?.ref ?? '',
    author: pr.user?.login ?? null,
    authorAvatarUrl: pr.user?.avatar_url ?? null,
    createdAt: pr.created_at ?? '',
    updatedAt: pr.updated_at ?? '',
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    changedFiles: pr.changed_files ?? null,
  };
}

/**
 * One pull request in detail.
 *
 * `mergeable_state` is why this exists separately from the summary: the list
 * endpoint does not return it, and it is the field that explains a refusal.
 * `blocked` is a protection rule, `dirty` is a conflict, `clean` will merge.
 * GitHub computes it asynchronously and answers `unknown` until it has, which
 * is passed through rather than guessed at.
 */
export function toPullRequestDetail(
  pr: GitHubPullRequestRow,
): GitHubPullRequestDetail {
  return {
    ...toPullRequestSummary(pr),
    mergeable: pr.mergeable ?? null,
    mergeableState: pr.mergeable_state ?? 'unknown',
    headSha: pr.head?.sha ?? '',
    body: pr.body ?? null,
  };
}

/**
 * GitHub omits `patch` for binary files and for very large diffs. That is
 * passed through as null rather than defaulted to an empty string, so the UI
 * can say "diff not shown" instead of rendering a changed file as unchanged.
 */
export function toPullRequestFile(
  file: GitHubPullRequestFileRow,
): GitHubPullRequestFile {
  return {
    filename: file.filename ?? '',
    status: file.status ?? 'modified',
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    changes: file.changes ?? 0,
    patch: file.patch ?? null,
  };
}

/** GitHub stops listing files in a comparison at this many. */
export const COMPARE_FILE_LIMIT = 300;

export interface GitHubCompareRow {
  status?: string;
  ahead_by?: number;
  behind_by?: number;
  total_commits?: number;
  commits?: {
    sha?: string;
    commit?: {
      message?: string;
      author?: { name?: string; date?: string } | null;
    };
    author?: { login?: string } | null;
  }[];
  files?: GitHubPullRequestFileRow[];
}

const COMPARE_STATUSES: ReadonlyArray<GitHubBranchComparison['status']> = [
  'ahead',
  'behind',
  'diverged',
  'identical',
];

/**
 * A comparison of two branches, shaped like the pull request it would become.
 *
 * Files reuse the pull-request file mapping so one diff renderer serves both
 * the preview before a pull request exists and the pull request after.
 */
export function toBranchComparison(
  row: GitHubCompareRow,
): GitHubBranchComparison {
  const files = (row.files ?? []).map((file) => toPullRequestFile(file));
  const status = COMPARE_STATUSES.find((value) => value === row.status);

  return {
    // An unrecognised status is treated as diverged: it still has commits to
    // show, and claiming 'identical' would hide a real change.
    status: status ?? 'diverged',
    aheadBy: row.ahead_by ?? 0,
    behindBy: row.behind_by ?? 0,
    totalCommits: row.total_commits ?? 0,
    commits: (row.commits ?? []).map((commit) => toComparisonCommit(commit)),
    files,
    filesTruncated: files.length >= COMPARE_FILE_LIMIT,
  };
}

function toComparisonCommit(
  commit: NonNullable<GitHubCompareRow['commits']>[number],
): GitHubComparisonCommit {
  return {
    sha: commit.sha ?? '',
    headline: (commit.commit?.message ?? '').split('\n')[0] ?? '',
    // The GitHub login when the commit is linked to an account, otherwise the
    // name git recorded, so an unlinked author is still named.
    author: commit.author?.login ?? commit.commit?.author?.name ?? null,
    authoredAt: commit.commit?.author?.date ?? null,
  };
}

/**
 * A branch name made safe for a URL path segment.
 *
 * Slashes are kept: `feature/login` is one ref, and GitHub's compare endpoint
 * resolves it unencoded, while `%2F` is read as a literal and 404s. Everything
 * else that could break the path (`#`, `?`, spaces) is encoded.
 */
export function encodeRef(ref: string): string {
  return encodeURIComponent(ref).replace(/%2F/gi, '/');
}

interface GitHubValidationBody {
  message?: string;
  errors?: { message?: string; field?: string; code?: string }[];
}

/**
 * GitHub's 422 as one sentence a person can act on.
 *
 * The top-level message is always "Validation Failed", which says nothing; the
 * useful sentence ("A pull request already exists for …", "No commits between
 * main and feature") is inside `errors`. A field error with no message is
 * spelled out rather than dropped, because "head invalid" still names the
 * branch that is wrong.
 */
export function validationMessage(text: string): string {
  let parsed: GitHubValidationBody;
  try {
    parsed = JSON.parse(text) as GitHubValidationBody;
  } catch {
    return text.slice(0, 300) || 'GitHub rejected the request.';
  }

  const details = (parsed.errors ?? [])
    .map(
      (error) =>
        error.message ??
        (error.field ? `${error.field} is ${error.code ?? 'invalid'}` : ''),
    )
    .filter((sentence) => sentence.length > 0);

  if (details.length > 0) return details.join(' ');
  return parsed.message ?? 'GitHub rejected the request.';
}

/**
 * Why GitHub refused a write made with a PERSON's token, in words for that
 * person, or null when the status is not one of these refusals.
 *
 * - 401: GitHub no longer accepts the token. The session stores it once at
 *   sign-in and can outlive it: GitHub keeps ten tokens per user and OAuth
 *   app, and an eleventh sign-in anywhere revokes the oldest. Only a new
 *   sign-in mints a fresh one.
 * - 403 / 404: the person lacks write access (GitHub answers 404 for a private
 *   repository it will not reveal). A rate-limit 403 that outlasted the
 *   retries is GitHub being busy, so it is NOT reported as missing access.
 */
export function userWriteRefusal(
  status: number,
  rateLimited: boolean,
  repoFullName: string,
): string | null {
  if (status === 401) {
    return 'GitHub no longer accepts your sign-in, which happens when it has been revoked or replaced by a newer one. Sign out and sign in again, then retry.';
  }
  if ((status === 403 && !rateLimited) || status === 404) {
    return `Your GitHub account does not have write access to ${repoFullName}. Ask a repository admin to grant it.`;
  }
  return null;
}
