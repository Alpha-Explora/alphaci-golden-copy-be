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

  it('lists every file path at a ref from the recursive tree, without folders', async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        tree: [
          { path: 'e2e', type: 'tree' },
          { path: 'e2e/home.spec.ts', type: 'blob' },
          { path: 'package.json', type: 'blob' },
        ],
        truncated: false,
      }),
    );
    const result = await client.listRepoPaths('t', 'o/r', 'dev');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/o/r/git/trees/dev?recursive=1',
    );
    expect(result).toEqual({
      read: true,
      paths: ['e2e/home.spec.ts', 'package.json'],
      truncated: false,
    });
  });

  it('reports a 401 tree read as unauthorized and throws on any other refusal', async () => {
    fetchMock.mockResolvedValueOnce(response(401));
    await expect(
      client.listRepoPaths('t', 'o/r', 'dev'),
    ).resolves.toMatchObject({
      read: false,
      reason: 'unauthorized',
    });
    fetchMock.mockResolvedValue(response(500, { message: 'boom' }));
    await expect(client.listRepoPaths('t', 'o/r', 'dev')).rejects.toThrow(
      'GitHub tree read failed (500)',
    );
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

  it('advances an existing branch: head -> commit -> tree on top of it -> commit -> ref', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { object: { sha: 'head' } }))
      .mockResolvedValueOnce(response(200, { tree: { sha: 'headtree' } }))
      .mockResolvedValueOnce(response(201, { sha: 'tree1' }))
      .mockResolvedValueOnce(response(201, { sha: 'commit1' }))
      .mockResolvedValueOnce(response(200, {}));

    const result = await client.commitFilesToBranch('t', 'o/r', {
      branch: 'uat',
      message: 'ci: point',
      files: [{ path: '.github/workflows/ci.yml', content: 'new' }],
    });

    expect(result).toEqual({ committed: true, commitSha: 'commit1' });
    const urls = fetchMock.mock.calls.map(
      (c) =>
        `${String(c[1]?.method ?? 'GET')} ${String(c[0]).split('/repos/o/r')[1]}`,
    );
    expect(urls).toEqual([
      'GET /git/ref/heads/uat',
      'GET /git/commits/head',
      'POST /git/trees',
      'POST /git/commits',
      'PATCH /git/refs/heads/uat',
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      base_tree: 'headtree',
      tree: [
        {
          path: '.github/workflows/ci.yml',
          mode: '100644',
          type: 'blob',
          content: 'new',
        },
      ],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      message: 'ci: point',
      tree: 'tree1',
      parents: ['head'],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({
      sha: 'commit1',
    });
  });

  it("returns GitHub's own sentence when it refuses to move the branch", async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { object: { sha: 'head' } }))
      .mockResolvedValueOnce(response(200, { tree: { sha: 'headtree' } }))
      .mockResolvedValueOnce(response(201, { sha: 'tree1' }))
      .mockResolvedValueOnce(response(201, { sha: 'commit1' }))
      .mockResolvedValueOnce(
        response(422, {
          message: 'Changes must be made through a pull request.',
        }),
      );

    await expect(
      client.commitFilesToBranch('t', 'o/r', {
        branch: 'dev',
        message: 'm',
        files: [{ path: 'a.yml', content: 'x' }],
      }),
    ).resolves.toEqual({
      committed: false,
      reason: 'refused',
      message:
        'GitHub would not update dev: Changes must be made through a pull request.',
    });
  });

  it('reports a branch that does not exist without writing anything', async () => {
    fetchMock.mockResolvedValueOnce(response(404));

    await expect(
      client.commitFilesToBranch('t', 'o/r', {
        branch: 'uat',
        message: 'm',
        files: [{ path: 'a.yml', content: 'x' }],
      }),
    ).resolves.toEqual({
      committed: false,
      reason: 'base_missing',
      message: "Branch 'uat' does not exist in o/r.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
