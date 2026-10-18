import { BadGatewayException } from '@nestjs/common';

import type {
  GitHubPathCommit,
  GitHubPathCommits,
} from '#kernel/ports/github.port';
import type { GithubHttp } from './github-http';

/**
 * The latest commit per path for the Code tab's file list.
 *
 * GitHub's contents API carries no commit at all, and asking the commits API
 * once per entry would cost a directory of 40 files 40 requests. One GraphQL
 * query asks for `history(first: 1, path: …)` per entry under an alias, so
 * a directory costs one request per 50 entries. Paths travel as variables,
 * never spliced into the query text.
 */

/** Entries per GraphQL request. */
export const PATH_COMMITS_BATCH = 50;
/** Entries asked about per directory; the rest render without a commit. */
export const PATH_COMMITS_MAX_ENTRIES = 300;

const COMMIT_FIELDS =
  'fragment C on Commit { oid abbreviatedOid messageHeadline committedDate author { name avatarUrl user { login } } }';

interface CommitNode {
  oid?: string;
  abbreviatedOid?: string;
  messageHeadline?: string;
  committedDate?: string;
  author?: {
    name?: string | null;
    avatarUrl?: string | null;
    user?: { login?: string | null } | null;
  } | null;
}

interface HistoryNode {
  totalCount?: number;
  nodes?: CommitNode[];
}

export function buildPathCommitsQuery(
  entryCount: number,
  withLatest: boolean,
): string {
  const variables = ['$owner:String!', '$name:String!', '$ref:String!'];
  const fields: string[] = [];
  if (withLatest) {
    variables.push('$dir:String');
    fields.push(
      'latest: history(first: 1, path: $dir) { totalCount nodes { ...C } }',
    );
  }
  for (let index = 0; index < entryCount; index += 1) {
    variables.push(`$p${String(index)}:String!`);
    fields.push(
      `e${String(index)}: history(first: 1, path: $p${String(index)}) { nodes { ...C } }`,
    );
  }
  return `query(${variables.join(',')}) { repository(owner: $owner, name: $name) { object(expression: $ref) { ... on Commit { ${fields.join(' ')} } } } } ${COMMIT_FIELDS}`;
}

function toPathCommit(node: CommitNode | undefined): GitHubPathCommit | null {
  if (!node?.oid || !node.committedDate) return null;
  return {
    sha: node.oid,
    shortSha: node.abbreviatedOid ?? node.oid.slice(0, 7),
    message: node.messageHeadline ?? '',
    committedAt: node.committedDate,
    authorLogin: node.author?.user?.login ?? null,
    authorName: node.author?.name ?? null,
    authorAvatarUrl: node.author?.avatarUrl ?? null,
  };
}

async function runBatch(
  http: GithubHttp,
  accessToken: string,
  repoFullName: string,
  ref: string,
  dirPath: string,
  paths: readonly string[],
  withLatest: boolean,
): Promise<Record<string, HistoryNode | null | undefined> | null> {
  const [owner, name] = repoFullName.split('/');
  const variables: Record<string, string | null> = {
    owner: owner ?? '',
    name: name ?? '',
    ref,
  };
  // An empty path means the repository root: no path filter at all.
  if (withLatest) variables['dir'] = dirPath || null;
  paths.forEach((path, index) => {
    variables[`p${String(index)}`] = path;
  });

  const response = await http.fetchWithRetry('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      ...http.workspaceHeaders(accessToken),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: buildPathCommitsQuery(paths.length, withLatest),
      variables,
    }),
  });
  if (!response.ok) {
    throw new BadGatewayException(
      `GitHub path commits failed (${String(response.status)})`,
    );
  }
  const payload = (await response.json()) as {
    data?: {
      repository?: {
        object?: Record<string, HistoryNode | null | undefined> | null;
      } | null;
    };
  };
  // A ref GitHub cannot resolve answers with a null object, not an error.
  return payload.data?.repository?.object ?? null;
}

export async function listPathCommits(
  http: GithubHttp,
  accessToken: string,
  repoFullName: string,
  ref: string,
  dirPath: string,
  entryPaths: readonly string[],
): Promise<GitHubPathCommits> {
  const asked = entryPaths.slice(0, PATH_COMMITS_MAX_ENTRIES);
  const batches: string[][] = [];
  for (let start = 0; start < asked.length; start += PATH_COMMITS_BATCH) {
    batches.push(asked.slice(start, start + PATH_COMMITS_BATCH));
  }
  if (batches.length === 0) batches.push([]);

  const results = await Promise.all(
    batches.map((paths, index) =>
      runBatch(
        http,
        accessToken,
        repoFullName,
        ref,
        dirPath,
        paths,
        index === 0,
      ),
    ),
  );

  const entries: Record<string, GitHubPathCommit | null> = {};
  for (const path of entryPaths) entries[path] = null;
  batches.forEach((paths, batchIndex) => {
    const object = results[batchIndex];
    paths.forEach((path, index) => {
      entries[path] = toPathCommit(object?.[`e${String(index)}`]?.nodes?.[0]);
    });
  });

  const latest = results[0]?.['latest'];
  return {
    latest: toPathCommit(latest?.nodes?.[0]),
    totalCommits:
      typeof latest?.totalCount === 'number' ? latest.totalCount : null,
    entries,
  };
}
