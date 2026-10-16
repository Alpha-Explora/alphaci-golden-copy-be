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

  it('builds on the recorded head without reading the branch first, and makes the commit on that parent', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { tree: { sha: 'recordedtree' } }))
      .mockResolvedValueOnce(response(201, { sha: 'blob1' }))
      .mockResolvedValueOnce(response(201, { sha: 'tree1' }))
      .mockResolvedValueOnce(response(201, { sha: 'commit1' }))
      .mockResolvedValueOnce(response(200, { object: { sha: 'recorded' } }))
      .mockResolvedValueOnce(response(201, {}));

    const result = await client.commitFilesToNewBranch('t', 'o/r', {
      fromBranch: 'dev',
      fromSha: 'recorded',
      newBranch: 'alphaci/repair-ci-api-url',
      message: 'm',
      files: [{ path: '.github/workflows/ci.yml', content: 'new' }],
    });

    expect(result).toEqual({ committed: true, commitSha: 'commit1' });
    const urls = fetchMock.mock.calls.map(
      (c) =>
        `${String(c[1]?.method ?? 'GET')} ${String(c[0]).split('/repos/o/r')[1]}`,
    );
    expect(urls).toEqual([
      'GET /git/commits/recorded',
      'POST /git/blobs',
      'POST /git/trees',
      'POST /git/commits',
      'GET /git/ref/heads/dev',
      'POST /git/refs',
    ]);
    expect(
      JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)),
    ).toMatchObject({
      parents: ['recorded'],
    });
  });

  it('refuses to create the branch when the base branch moved since the recorded head', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { tree: { sha: 'recordedtree' } }))
      .mockResolvedValueOnce(response(201, { sha: 'blob1' }))
      .mockResolvedValueOnce(response(201, { sha: 'tree1' }))
      .mockResolvedValueOnce(response(201, { sha: 'commit1' }))
      .mockResolvedValueOnce(response(200, { object: { sha: 'moved' } }));

    await expect(
      client.commitFilesToNewBranch('t', 'o/r', {
        fromBranch: 'dev',
        fromSha: 'recorded',
        newBranch: 'alphaci/repair-ci-api-url',
        message: 'm',
        files: [{ path: 'a.yml', content: 'x' }],
      }),
    ).resolves.toMatchObject({ committed: false, reason: 'base_moved' });
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/git/refs')),
    ).toBe(false);
  });

  it('moves an existing branch to the new commit when asked, and reports a refusal to move it', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { tree: { sha: 'recordedtree' } }))
      .mockResolvedValueOnce(response(201, { sha: 'blob1' }))
      .mockResolvedValueOnce(response(201, { sha: 'tree1' }))
      .mockResolvedValueOnce(response(201, { sha: 'commit1' }))
      .mockResolvedValueOnce(response(200, { object: { sha: 'recorded' } }))
      .mockResolvedValueOnce(response(200, {}));

    const result = await client.commitFilesToNewBranch('t', 'o/r', {
      fromBranch: 'dev',
      fromSha: 'recorded',
      newBranch: 'alphaci/repair-ci-api-url',
      message: 'm',
      files: [{ path: '.github/workflows/ci.yml', content: 'new' }],
      replaceExisting: true,
    });

    expect(result).toEqual({ committed: true, commitSha: 'commit1' });
    const urls = fetchMock.mock.calls.map(
      (c) =>
        `${String(c[1]?.method ?? 'GET')} ${String(c[0]).split('/repos/o/r')[1]}`,
    );
    expect(urls.at(-1)).toBe('PATCH /git/refs/heads/alphaci/repair-ci-api-url');
    expect(urls).not.toContain('POST /git/refs');
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toEqual({
      sha: 'commit1',
    });
  });

  it('reports a branch GitHub will not move as branch_exists, so the caller can look again', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { tree: { sha: 'recordedtree' } }))
      .mockResolvedValueOnce(response(201, { sha: 'blob1' }))
      .mockResolvedValueOnce(response(201, { sha: 'tree1' }))
      .mockResolvedValueOnce(response(201, { sha: 'commit1' }))
      .mockResolvedValueOnce(response(200, { object: { sha: 'recorded' } }))
      .mockResolvedValueOnce(
        response(422, { message: 'Update is not a fast forward' }),
      );

    await expect(
      client.commitFilesToNewBranch('t', 'o/r', {
        fromBranch: 'dev',
        fromSha: 'recorded',
        newBranch: 'alphaci/repair-ci-api-url',
        message: 'm',
        files: [{ path: 'a.yml', content: 'x' }],
        replaceExisting: true,
      }),
    ).resolves.toMatchObject({ committed: false, reason: 'branch_exists' });
  });

  it('reads a branch head, and reports an absent branch as null', async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, { object: { sha: 'head1' } }))
      .mockResolvedValueOnce(response(404));

    await expect(client.readBranchHead('t', 'o/r', 'dev')).resolves.toBe(
      'head1',
    );
    await expect(client.readBranchHead('t', 'o/r', 'gone')).resolves.toBeNull();
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
