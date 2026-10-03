import { Logger, UnauthorizedException } from '@nestjs/common';

import { GithubActivityClient } from './github-activity.client';
import { GithubHttp } from './github-http';

const response = (
  status: number,
  body: unknown = [],
  headers: Record<string, string> = {},
) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

describe('GithubActivityClient', () => {
  let fetchMock: jest.Mock;
  let client: GithubActivityClient;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    client = new GithubActivityClient(new GithubHttp(new Logger('test')));
  });

  describe('listCommits', () => {
    const row = {
      sha: 'abcdef1234567890',
      html_url: 'https://github.com/o/r/commit/abcdef1',
      commit: {
        message: 'feat: x (#12)\n\nbody',
        author: { name: 'Dev One', date: '2026-10-02T10:00:00Z' },
      },
      author: { login: 'devone' },
    };

    it('asks for one page of the branch and maps the rows', async () => {
      fetchMock.mockResolvedValueOnce(
        response(200, [row], {
          link: '<https://api.github.com/x?page=3>; rel="next"',
        }),
      );

      const page = await client.listCommits('tok', 'o/r', {
        branch: 'feature/a b',
        perPage: 30,
        page: 2,
      });

      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'https://api.github.com/repos/o/r/commits?sha=feature%2Fa+b&per_page=30&page=2',
      );
      expect(page.hasNextPage).toBe(true);
      expect(page.items).toEqual([
        {
          sha: 'abcdef1234567890',
          message: 'feat: x (#12)\n\nbody',
          authorLogin: 'devone',
          authorName: 'Dev One',
          authoredAt: '2026-10-02T10:00:00Z',
          url: 'https://github.com/o/r/commit/abcdef1',
        },
      ]);
    });

    it('has no next page without a Link rel="next"', async () => {
      fetchMock.mockResolvedValueOnce(response(200, [row]));

      expect(
        (
          await client.listCommits('tok', 'o/r', {
            branch: 'dev',
            perPage: 30,
            page: 1,
          })
        ).hasNextPage,
      ).toBe(false);
    });

    it.each([404, 409])('answers %s with an empty page', async (status) => {
      fetchMock.mockResolvedValueOnce(response(status, {}));

      await expect(
        client.listCommits('tok', 'o/r', {
          branch: 'dev',
          perPage: 30,
          page: 1,
        }),
      ).resolves.toEqual({ items: [], hasNextPage: false });
    });

    it('maps a 401 to the sign-in-again sentence', async () => {
      fetchMock.mockResolvedValueOnce(response(401, { message: 'Bad' }));

      const failure = client.listCommits('tok', 'o/r', {
        branch: 'dev',
        perPage: 30,
        page: 1,
      });
      await expect(failure).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(failure).rejects.toThrow('sign in again');
    });

    it('reports other failures as a bad gateway', async () => {
      fetchMock.mockResolvedValueOnce(response(500, { message: 'boom' }));

      await expect(
        client.listCommits('tok', 'o/r', {
          branch: 'dev',
          perPage: 30,
          page: 1,
        }),
      ).rejects.toThrow('GitHub commit list failed (500)');
    });
  });

  describe('listRepositoryEvents', () => {
    const event = (id: string) => ({
      id,
      type: 'PushEvent',
      actor: { login: 'dev' },
      created_at: '2026-10-02T10:00:00Z',
      payload: { ref: 'refs/heads/dev' },
    });

    it('sends If-None-Match and answers 304 as not modified', async () => {
      fetchMock.mockResolvedValueOnce(response(304, null));

      await expect(
        client.listRepositoryEvents('tok', 'o/r', { etag: 'W/"abc"' }),
      ).resolves.toEqual({ status: 'not_modified' });

      const init = fetchMock.mock.calls[0]?.[1] as {
        headers: Record<string, string>;
      };
      expect(init.headers['If-None-Match']).toBe('W/"abc"');
    });

    it('reads up to three pages and returns the first page ETag', async () => {
      fetchMock
        .mockResolvedValueOnce(
          response(200, [event('1')], {
            etag: 'W/"new"',
            link: '<https://api.github.com/x?page=2>; rel="next"',
          }),
        )
        .mockResolvedValueOnce(
          response(200, [event('2')], {
            link: '<https://api.github.com/x?page=3>; rel="next"',
          }),
        )
        .mockResolvedValueOnce(
          response(200, [event('3')], {
            link: '<https://api.github.com/x?page=4>; rel="next"',
          }),
        );

      const result = await client.listRepositoryEvents('tok', 'o/r');

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ status: 'modified', etag: 'W/"new"' });
      if (result.status === 'modified') {
        expect(result.events.map((e) => e.id)).toEqual(['1', '2', '3']);
        expect(result.events[0]).toMatchObject({
          type: 'PushEvent',
          actor: { login: 'dev' },
          createdAt: '2026-10-02T10:00:00Z',
        });
      }
    });

    it('maps 401 to sign-in-again and other errors to a bad gateway', async () => {
      fetchMock.mockResolvedValueOnce(response(401, {}));
      await expect(client.listRepositoryEvents('tok', 'o/r')).rejects.toThrow(
        UnauthorizedException,
      );

      fetchMock.mockResolvedValueOnce(response(502, { message: 'down' }));
      await expect(client.listRepositoryEvents('tok', 'o/r')).rejects.toThrow(
        'GitHub repository events failed (502)',
      );
    });
  });

  describe('compareCommits / getPullRequestHeadline', () => {
    it('summarises a push and caps the commit list', async () => {
      fetchMock.mockResolvedValueOnce(
        response(200, {
          status: 'ahead',
          total_commits: 45,
          commits: Array.from({ length: 30 }, (_, i) => ({
            sha: `s${String(i)}`,
            commit: { message: `m${String(i)}`, author: { name: 'A' } },
          })),
        }),
      );

      const pushed = await client.compareCommits('tok', 'o/r', 'b', 'h', 20);

      expect(fetchMock.mock.calls[0]?.[0]).toContain(
        '/compare/b...h?per_page=20',
      );
      expect(pushed?.status).toBe('ahead');
      expect(pushed?.totalCommits).toBe(45);
      expect(pushed?.commits).toHaveLength(20);
    });

    it('returns null when GitHub no longer has the commits', async () => {
      fetchMock.mockResolvedValueOnce(response(404, {}));

      await expect(
        client.compareCommits('tok', 'o/r', 'b', 'h'),
      ).resolves.toBeNull();
    });

    it('reads the title and merge facts of a pull request', async () => {
      fetchMock.mockResolvedValueOnce(
        response(200, {
          title: 'Promote',
          merged: true,
          merged_by: { login: 'lead' },
          html_url: 'https://github.com/o/r/pull/1',
        }),
      );

      await expect(
        client.getPullRequestHeadline('tok', 'o/r', 1),
      ).resolves.toEqual({
        title: 'Promote',
        merged: true,
        mergedByLogin: 'lead',
        htmlUrl: 'https://github.com/o/r/pull/1',
      });
    });
  });
});
