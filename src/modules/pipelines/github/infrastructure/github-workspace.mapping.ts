import type {
  GitHubContentEntry,
  GitHubContentEntryType,
  GitHubContentListing,
  GitHubPullRequestFile,
  GitHubPullRequestDetail,
  GitHubPullRequestSummary,
} from './github-workspace.types';

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
