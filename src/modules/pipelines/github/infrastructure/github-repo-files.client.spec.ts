import { Logger } from '@nestjs/common';

import { GithubHttp } from './github-http';
import { GithubRepoFilesClient } from './github-repo-files.client';

const response = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

describe('GithubRepoFilesClient', () => {
  let fetchMock: jest.Mock;
  let client: GithubRepoFilesClient;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    client = new GithubRepoFilesClient(new GithubHttp(new Logger('test')));
  });

  it('probes each path: present, absent', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/contents/package.json')
          ? response(200, {
              encoding: 'base64',
              content: Buffer.from('{"a":1}').toString('base64'),
            })
          : response(404),
      ),
    );
    const result = await client.readRepoFiles('t', 'o/r', 'dev', [
      'package.json',
      'yarn.lock',
    ]);
    expect(result).toEqual({
      read: true,
      files: {
        'package.json': { exists: true, content: '{"a":1}' },
        'yarn.lock': { exists: false, content: null },
      },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toContain('?ref=dev');
  });

  it('reports a 401 as unauthorized rather than as missing files', async () => {
    fetchMock.mockResolvedValue(response(401));
    const result = await client.readRepoFiles('t', 'o/r', 'dev', ['a']);
    expect(result).toMatchObject({ read: false, reason: 'unauthorized' });
  });

  it('commits blobs -> tree -> commit -> ref, in that order, creating the ref last', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { object: { sha: 'base' } }))
      .mockResolvedValueOnce(response(200, { tree: { sha: 'basetree' } }))
      .mockResolvedValueOnce(response(201, { sha: 'blob1' }))
      .mockResolvedValueOnce(response(201, { sha: 'blob2' }))
      .mockResolvedValueOnce(response(201, { sha: 'tree1' }))
      .mockResolvedValueOnce(response(201, { sha: 'commit1' }))
      .mockResolvedValueOnce(response(201, {}));

    const result = await client.commitFilesToNewBranch('t', 'o/r', {
      fromBranch: 'dev',
      newBranch: 'alphaci/browser-tests',
      message: 'm',
      files: [
        { path: 'a.ts', content: 'A' },
        { path: 'b.ts', content: 'B' },
      ],
    });

    expect(result).toEqual({ committed: true, commitSha: 'commit1' });
    const urls = fetchMock.mock.calls.map(
      (c) => String(c[0]).split('/repos/o/r')[1],
    );
    expect(urls).toEqual([
      '/git/ref/heads/dev',
      '/git/commits/base',
      '/git/blobs',
      '/git/blobs',
      '/git/trees',
      '/git/commits',
      '/git/refs',
    ]);
    const treeBody = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body)) as {
      base_tree: string;
      tree: { path: string; sha: string }[];
    };
    expect(treeBody.base_tree).toBe('basetree');
    expect(treeBody.tree.map((e) => e.sha)).toEqual(['blob1', 'blob2']);
    expect(JSON.parse(String(fetchMock.mock.calls[6]?.[1]?.body))).toEqual({
      ref: 'refs/heads/alphaci/browser-tests',
      sha: 'commit1',
    });
  });

  it('maps 401, a missing base and a taken ref', async () => {
    const input = {
      fromBranch: 'dev',
      newBranch: 'n',
      message: 'm',
      files: [],
    };

    fetchMock.mockResolvedValueOnce(response(401));
    expect(
      await client.commitFilesToNewBranch('t', 'o/r', input),
    ).toMatchObject({
      committed: false,
      reason: 'unauthorized',
    });

    fetchMock.mockResolvedValueOnce(response(404));
    expect(
      await client.commitFilesToNewBranch('t', 'o/r', input),
    ).toMatchObject({
      committed: false,
      reason: 'base_missing',
    });

    fetchMock
      .mockResolvedValueOnce(response(200, { object: { sha: 'b' } }))
      .mockResolvedValueOnce(response(200, { tree: { sha: 't' } }))
      .mockResolvedValueOnce(response(201, { sha: 'tr' }))
      .mockResolvedValueOnce(response(201, { sha: 'c' }))
      .mockResolvedValueOnce(response(422));
    expect(
      await client.commitFilesToNewBranch('t', 'o/r', input),
    ).toMatchObject({
      committed: false,
      reason: 'branch_exists',
    });
  });
});
