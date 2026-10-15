import { BadGatewayException } from '@nestjs/common';

import type {
  GitHubCommitFilesInput,
  GitHubCommitFilesResult,
  GitHubCommitToBranchInput,
  GitHubCommitToBranchResult,
  GitHubRepoFileProbe,
  GitHubRepoFilesResult,
  GitHubRepoPathsResult,
} from '#kernel/ports/github.port';
import type { GithubHttp } from './github-http';
import { userWriteRefusal } from './github-workspace.mapping';

interface TreeRow {
  tree?: { path?: string; type?: string }[];
  truncated?: boolean;
}

interface ContentsRow {
  content?: string;
  encoding?: string;
}

/**
 * Reading a few paths and committing several files at once.
 *
 * Split from GithubService, like the activity client, because the Git Data
 * flow is five requests with their own failure vocabulary and the service is
 * already well past a comfortable size.
 */
export class GithubRepoFilesClient {
  constructor(private readonly http: GithubHttp) {}

  /**
   * Probe `paths` at `ref`. A 404 is "not there"; a 401 is reported (the
   * caller turns it into "sign in again"); anything else is a transport
   * failure and throws, so a flaky read is never mistaken for an absent file.
   */
  async readRepoFiles(
    accessToken: string,
    repoFullName: string,
    ref: string,
    paths: readonly string[],
  ): Promise<GitHubRepoFilesResult> {
    const probes = await Promise.all(
      paths.map(async (path) => {
        const response = await this.http.fetchWithRetry(
          `https://api.github.com/repos/${repoFullName}/contents/${path
            .split('/')
            .map(encodeURIComponent)
            .join('/')}?ref=${encodeURIComponent(ref)}`,
          { headers: this.http.workspaceHeaders(accessToken) },
        );

        if (response.status === 401) {
          return 'unauthorized' as const;
        }
        if (response.status === 404) {
          return [path, { exists: false, content: null }] as const;
        }
        if (!response.ok) {
          const body = await response.text();
          throw new BadGatewayException(
            `GitHub file read failed (${String(response.status)}): ${body.slice(0, 300)}`,
          );
        }

        const payload = (await response.json()) as ContentsRow | ContentsRow[];
        const content =
          !Array.isArray(payload) &&
          payload.encoding === 'base64' &&
          payload.content
            ? Buffer.from(payload.content, 'base64').toString('utf8')
            : null;
        return [path, { exists: true, content }] as const;
      }),
    );

    if (probes.includes('unauthorized')) {
      return {
        read: false,
        reason: 'unauthorized',
        message:
          userWriteRefusal(401, false, repoFullName) ??
          'GitHub no longer accepts your sign-in.',
      };
    }

    const files: Record<string, GitHubRepoFileProbe> = {};
    for (const probe of probes) {
      if (probe !== 'unauthorized') {
        files[probe[0]] = probe[1];
      }
    }
    return { read: true, files };
  }

  /**
   * Every file (blob) path at `ref`, from the recursive tree. A 401 is
   * reported, like readRepoFiles; any other refusal throws, so a failed read
   * is never mistaken for an empty repository.
   */
  async listRepoPaths(
    accessToken: string,
    repoFullName: string,
    ref: string,
  ): Promise<GitHubRepoPathsResult> {
    const response = await this.http.fetchWithRetry(
      `https://api.github.com/repos/${repoFullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      { headers: this.http.workspaceHeaders(accessToken) },
    );
    if (response.status === 401) {
      return {
        read: false,
        reason: 'unauthorized',
        message:
          userWriteRefusal(401, false, repoFullName) ??
          'GitHub no longer accepts your sign-in.',
      };
    }
    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub tree read failed (${String(response.status)}): ${body.slice(0, 300)}`,
      );
    }
    const payload = (await response.json()) as TreeRow;
    const paths = (payload.tree ?? [])
      .filter(
        (entry) => entry.type === 'blob' && typeof entry.path === 'string',
      )
      .map((entry) => entry.path as string);
    return { read: true, paths, truncated: payload.truncated === true };
  }

  /**
   * blobs -> tree -> commit -> ref, in that order.
   *
   * The branch ref is created LAST on purpose. Everything before it only
   * writes objects nothing points at, so a failure at any step leaves the
   * repository exactly as it was - no half-built branch to clean up.
   */
  async commitFilesToNewBranch(
    accessToken: string,
    repoFullName: string,
    input: GitHubCommitFilesInput,
  ): Promise<GitHubCommitFilesResult> {
    const api = `https://api.github.com/repos/${repoFullName}`;
    const headers = {
      ...this.http.workspaceHeaders(accessToken),
      'Content-Type': 'application/json',
    };

    const refused = (status: number, rateLimited: boolean) => {
      const message = userWriteRefusal(status, rateLimited, repoFullName);
      if (!message) {
        return null;
      }
      return {
        committed: false,
        reason: status === 401 ? 'unauthorized' : 'forbidden',
        message,
      } as const;
    };

    const post = async (url: string, body: unknown) =>
      this.http.fetchWithRetry(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

    // 1. The commit the new branch starts from.
    const baseRes = await this.http.fetchWithRetry(
      `${api}/git/ref/heads/${input.fromBranch
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`,
      { headers: this.http.workspaceHeaders(accessToken) },
    );
    if (baseRes.status === 404) {
      // 404 is also how GitHub hides a private repository from a token that
      // cannot see it; the access message is the more useful of the two when
      // the branch was just listed, but here the caller already read it.
      return {
        committed: false,
        reason: 'base_missing',
        message: `Branch '${input.fromBranch}' does not exist in ${repoFullName}.`,
      };
    }
    const baseRefusal = refused(
      baseRes.status,
      baseRes.headers?.get('x-ratelimit-remaining') === '0',
    );
    if (baseRefusal) {
      return baseRefusal;
    }
    const baseSha = await this.requireOk<{ object: { sha: string } }>(
      baseRes,
      'branch lookup',
    );

    const commitRes = await this.http.fetchWithRetry(
      `${api}/git/commits/${baseSha.object.sha}`,
      { headers: this.http.workspaceHeaders(accessToken) },
    );
    const baseCommit = await this.requireOk<{ tree: { sha: string } }>(
      commitRes,
      'base commit lookup',
    );

    // 2. One blob per file. utf-8 keeps the content as written.
    const treeEntries: {
      path: string;
      mode: '100644';
      type: 'blob';
      sha: string;
    }[] = [];
    for (const file of input.files) {
      const blobRes = await post(`${api}/git/blobs`, {
        content: file.content,
        encoding: 'utf-8',
      });
      const blobRefusal = refused(
        blobRes.status,
        blobRes.headers?.get('x-ratelimit-remaining') === '0',
      );
      if (blobRefusal) {
        return blobRefusal;
      }
      const blob = await this.requireOk<{ sha: string }>(
        blobRes,
        'blob upload',
      );
      treeEntries.push({
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      });
    }

    // 3. A tree on top of the base tree, so every other file is untouched.
    const treeRes = await post(`${api}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree: treeEntries,
    });
    const tree = await this.requireOk<{ sha: string }>(
      treeRes,
      'tree creation',
    );

    // 4. The commit.
    const newCommitRes = await post(`${api}/git/commits`, {
      message: input.message,
      tree: tree.sha,
      parents: [baseSha.object.sha],
    });
    const commit = await this.requireOk<{ sha: string }>(
      newCommitRes,
      'commit creation',
    );

    // 5. The branch itself.
    const refRes = await post(`${api}/git/refs`, {
      ref: `refs/heads/${input.newBranch}`,
      sha: commit.sha,
    });
    if (refRes.status === 422) {
      return {
        committed: false,
        reason: 'branch_exists',
        message: `Branch '${input.newBranch}' already exists.`,
      };
    }
    await this.requireOk<unknown>(refRes, 'branch creation');

    return { committed: true, commitSha: commit.sha };
  }

  /**
   * Replace files on an existing branch as one commit: the branch head's tree
   * with the given files on top, committed on the head, then the branch ref
   * moved to it. Inline tree content keeps this to the four writes GitHub needs.
   *
   * The ref is the only step that can be refused on purpose (a protection
   * rule, a head that moved). That refusal is returned with GitHub's sentence;
   * any other failure throws, because it says nothing about the branch.
   */
  async commitFilesToBranch(
    accessToken: string,
    repoFullName: string,
    input: GitHubCommitToBranchInput,
  ): Promise<GitHubCommitToBranchResult> {
    const api = `https://api.github.com/repos/${repoFullName}`;
    const readHeaders = this.http.workspaceHeaders(accessToken);
    const writeHeaders = { ...readHeaders, 'Content-Type': 'application/json' };
    const branchPath = input.branch
      .split('/')
      .map(encodeURIComponent)
      .join('/');

    const headRes = await this.http.fetchWithRetry(
      `${api}/git/ref/heads/${branchPath}`,
      { headers: readHeaders },
    );
    if (headRes.status === 404) {
      return {
        committed: false,
        reason: 'base_missing',
        message: `Branch '${input.branch}' does not exist in ${repoFullName}.`,
      };
    }
    const head = await this.requireOk<{ object: { sha: string } }>(
      headRes,
      'branch lookup',
    );

    const headCommitRes = await this.http.fetchWithRetry(
      `${api}/git/commits/${head.object.sha}`,
      { headers: readHeaders },
    );
    const headCommit = await this.requireOk<{ tree: { sha: string } }>(
      headCommitRes,
      'base commit lookup',
    );

    const treeRes = await this.http.fetchWithRetry(`${api}/git/trees`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({
        base_tree: headCommit.tree.sha,
        tree: input.files.map((file) => ({
          path: file.path,
          mode: '100644',
          type: 'blob',
          content: file.content,
        })),
      }),
    });
    const tree = await this.requireOk<{ sha: string }>(
      treeRes,
      'tree creation',
    );

    const commitRes = await this.http.fetchWithRetry(`${api}/git/commits`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({
        message: input.message,
        tree: tree.sha,
        parents: [head.object.sha],
      }),
    });
    const commit = await this.requireOk<{ sha: string }>(
      commitRes,
      'commit creation',
    );

    const refRes = await this.http.fetchWithRetry(
      `${api}/git/refs/heads/${branchPath}`,
      {
        method: 'PATCH',
        headers: writeHeaders,
        body: JSON.stringify({ sha: commit.sha }),
      },
    );
    if (!refRes.ok) {
      return {
        committed: false,
        reason: 'refused',
        message: await refusalDetail(refRes, input.branch),
      };
    }

    return { committed: true, commitSha: commit.sha };
  }

  private async requireOk<T>(
    response: Awaited<ReturnType<GithubHttp['fetchWithRetry']>>,
    what: string,
  ): Promise<T> {
    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub ${what} failed (${String(response.status)}): ${body.slice(0, 300)}`,
      );
    }
    return (await response.json()) as T;
  }
}

/** GitHub's own sentence for a refused ref update, falling back to the status. */
async function refusalDetail(
  response: Awaited<ReturnType<GithubHttp['fetchWithRetry']>>,
  branch: string,
): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.length > 0) {
      return `GitHub would not update ${branch}: ${parsed.message}`;
    }
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return `GitHub would not update ${branch} (${String(response.status)}): ${body.slice(0, 300)}`;
}
