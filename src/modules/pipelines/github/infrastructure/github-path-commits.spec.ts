import { Logger } from '@nestjs/common';

import { GithubHttp } from './github-http';
import {
  buildPathCommitsQuery,
  listPathCommits,
  PATH_COMMITS_BATCH,
} from './github-path-commits';

const node = (
  oid: string,
  message: string,
  login: string | null = 'dev-one',
) => ({
  oid,
  abbreviatedOid: oid.slice(0, 7),
  messageHeadline: message,
  committedDate: '2026-10-01T00:00:00Z',
  author: {
    name: 'Dev One',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1',
    user: login ? { login } : null,
  },
});

const graphql = (object: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: () => Promise.resolve({ data: { repository: { object } } }),
});

describe('path commits for the Code tab', () => {
  let fetchMock: jest.Mock;
  let http: GithubHttp;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    http = new GithubHttp(new Logger('test'));
  });

  const body = (index: number) =>
    JSON.parse(
      (fetchMock.mock.calls[index] as [string, { body: string }])[1].body,
    ) as { query: string; variables: Record<string, string | null> };

  it('passes every path as a variable, never in the query text', () => {
    const query = buildPathCommitsQuery(2, true);
    expect(query).toContain('latest: history(first: 1, path: $dir)');
    expect(query).toContain('e0: history(first: 1, path: $p0)');
    expect(query).toContain('e1: history(first: 1, path: $p1)');
    expect(query).toContain('$p1:String!');
  });

  it('reads the folder and each entry in one request', async () => {
    fetchMock.mockResolvedValueOnce(
      graphql({
        latest: {
          totalCount: 288,
          nodes: [node('aaaaaaa111', 'Gate FE Sonar quality')],
        },
        e0: { nodes: [node('bbbbbbb222', 'docs: record split correction')] },
        e1: { nodes: [] },
      }),
    );

    const result = await listPathCommits(http, 'tok', 'org/repo', 'main', '', [
      'docs',
      'empty',
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.github.com/graphql');
    // The repository root asks for no path filter at all.
    expect(body(0).variables).toEqual({
      owner: 'org',
      name: 'repo',
      ref: 'main',
      dir: null,
      p0: 'docs',
      p1: 'empty',
    });
    expect(result).toEqual({
      latest: {
        sha: 'aaaaaaa111',
        shortSha: 'aaaaaaa',
        message: 'Gate FE Sonar quality',
        committedAt: '2026-10-01T00:00:00Z',
        authorLogin: 'dev-one',
        authorName: 'Dev One',
        authorAvatarUrl: 'https://avatars.githubusercontent.com/u/1',
      },
      totalCommits: 288,
      entries: {
        docs: expect.objectContaining({
          message: 'docs: record split correction',
        }),
        empty: null,
      },
    });
  });

  it('batches a large folder, asking for the folder itself only once', async () => {
    const paths = Array.from(
      { length: PATH_COMMITS_BATCH + 3 },
      (_, i) => `f${String(i)}`,
    );
    fetchMock
      .mockResolvedValueOnce(graphql({ latest: { totalCount: 1, nodes: [] } }))
      .mockResolvedValueOnce(
        graphql({ e2: { nodes: [node('ccccccc333', 'last one')] } }),
      );

    const result = await listPathCommits(
      http,
      'tok',
      'org/repo',
      'main',
      'src',
      paths,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body(0).query).toContain('latest:');
    expect(body(1).query).not.toContain('latest:');
    expect(body(1).variables['p2']).toBe(`f${String(PATH_COMMITS_BATCH + 2)}`);
    expect(result.entries[`f${String(PATH_COMMITS_BATCH + 2)}`]?.message).toBe(
      'last one',
    );
    expect(body(0).variables['dir']).toBe('src');
  });

  it('answers a ref GitHub cannot resolve with no commits instead of failing', async () => {
    fetchMock.mockResolvedValueOnce(graphql(null));

    await expect(
      listPathCommits(http, 'tok', 'org/repo', 'gone', '', ['a']),
    ).resolves.toEqual({
      latest: null,
      totalCommits: null,
      entries: { a: null },
    });
  });

  it('throws on a GitHub error so the caller can degrade', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      headers: { get: () => null },
      json: () => Promise.resolve({}),
    });

    await expect(
      listPathCommits(http, 'tok', 'org/repo', 'main', '', ['a']),
    ).rejects.toThrow('GitHub path commits failed (502)');
  });
});
