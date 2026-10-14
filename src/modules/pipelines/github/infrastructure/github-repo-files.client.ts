import { BadGatewayException } from '@nestjs/common';

import type {
  GitHubCommitFilesInput,
  GitHubCommitFilesResult,
  GitHubRepoFileProbe,
  GitHubRepoFilesResult,
} from '#kernel/ports/github.port';
import type { GithubHttp } from './github-http';
import { userWriteRefusal } from './github-workspace.mapping';

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
