import type { GithubProjectPort } from '#kernel/ports/github.port';

import {
  findStaleCiWorkflowFiles,
  resolvePlatformBaseUrl,
  rewriteCiApiBase,
} from './ci-api-base-url';

const CURRENT = 'https://dev-api.alphaci.com.ph';

describe('resolvePlatformBaseUrl', () => {
  it('prefers the explicit public URL and strips a trailing API path', () => {
    expect(
      resolvePlatformBaseUrl({ PLATFORM_PUBLIC_URL: `${CURRENT}/api/v1/` }),
    ).toBe(CURRENT);
  });

  it('derives the base from the GitHub callback when no public URL is set', () => {
    expect(
      resolvePlatformBaseUrl({
        GITHUB_CALLBACK_URL: `${CURRENT}/api/v1/auth/github/callback`,
      }),
    ).toBe(CURRENT);
  });

  it('falls back to localhost only when nothing is configured', () => {
    expect(resolvePlatformBaseUrl({})).toBe('http://localhost:4000');
  });
});

describe('rewriteCiApiBase', () => {
  it('leaves a file that already names the current base untouched', () => {
    const content = `env:\n  ALPHACI_VALIDATE_URL: ${CURRENT}/api/v1/ci/validate\n`;

    expect(rewriteCiApiBase(content, CURRENT)).toEqual({
      content,
      staleBases: [],
    });
  });

  it('rewrites a stale base in URLs and in the alphaci-api-url input', () => {
    const content = [
      "      ALPHACI_VALIDATE_URL: 'http://localhost:4000/api/v1/ci/validate'",
      '      ALPHACI_REPORT: http://localhost:4000/api/v1/ci/report',
      "        'alphaci-api-url': http://localhost:4000",
      '      uses: Alpha-Explora/central@v1',
    ].join('\n');

    const result = rewriteCiApiBase(content, CURRENT);

    expect(result.content).toBe(
      [
        `      ALPHACI_VALIDATE_URL: '${CURRENT}/api/v1/ci/validate'`,
        `      ALPHACI_REPORT: ${CURRENT}/api/v1/ci/report`,
        `        'alphaci-api-url': ${CURRENT}`,
        '      uses: Alpha-Explora/central@v1',
      ].join('\n'),
    );
    expect(result.staleBases).toEqual(['http://localhost:4000']);
  });

  it('handles a trailing slash and a quoted value on the input line', () => {
    const result = rewriteCiApiBase(
      'alphaci-api-url: "http://localhost:4000/"  # platform\n',
      CURRENT,
    );

    expect(result.content).toBe(`alphaci-api-url: "${CURRENT}"  # platform\n`);
    expect(result.staleBases).toEqual(['http://localhost:4000']);
  });

  it('never treats a longer path that merely starts with /api/v1/ci as the API', () => {
    const content = 'url: https://example.com/api/v1/ci-legacy/hook\n';

    expect(rewriteCiApiBase(content, CURRENT)).toEqual({
      content,
      staleBases: [],
    });
  });

  it('leaves unrelated URLs alone, such as GitHub and action sources', () => {
    const content = [
      'run: curl -s https://api.github.com/repos/o/r',
      'uses: https://github.com/Alpha-Explora/central@v1',
    ].join('\n');

    expect(rewriteCiApiBase(content, CURRENT)).toEqual({
      content,
      staleBases: [],
    });
  });
});

describe('findStaleCiWorkflowFiles', () => {
  const dir = (name: string) => ({
    name,
    path: `.github/workflows/${name}`,
    type: 'file' as const,
    size: 1,
    sha: name,
  });
  const staleYaml = `alphaci-api-url: http://localhost:4000\n`;

  const github = {
    listRepoContents: jest.fn(),
    getFileContent: jest.fn(),
  };
  const read = () =>
    findStaleCiWorkflowFiles(
      github as unknown as Pick<
        GithubProjectPort,
        'listRepoContents' | 'getFileContent'
      >,
      'token',
      'tone/orders-api',
      'dev',
      CURRENT,
    );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads no files on a branch that does not exist', async () => {
    github.listRepoContents.mockResolvedValue({
      path: '.github/workflows',
      ref: 'dev',
      entries: [],
      file: null,
    });

    await expect(read()).resolves.toEqual([]);
    expect(github.getFileContent).not.toHaveBeenCalled();
  });

  it('reads only workflow YAML files, not folders or other files', async () => {
    github.listRepoContents.mockResolvedValue({
      path: '.github/workflows',
      ref: 'dev',
      entries: [
        { ...dir('ci.yml') },
        { ...dir('release.yaml') },
        { ...dir('README.md') },
        {
          name: 'nested',
          path: '.github/workflows/nested',
          type: 'dir',
          size: 0,
          sha: 'd',
        },
      ],
      file: null,
    });
    github.getFileContent.mockResolvedValue(staleYaml);

    await read();

    expect(github.getFileContent).toHaveBeenCalledTimes(2);
    expect(github.getFileContent).toHaveBeenCalledWith(
      'token',
      'tone',
      'orders-api',
      '.github/workflows/ci.yml',
      'dev',
    );
  });

  it('returns only the files that name another base, already rewritten', async () => {
    github.listRepoContents.mockResolvedValue({
      path: '.github/workflows',
      ref: 'dev',
      entries: [dir('current.yml'), dir('stale.yml')],
      file: null,
    });
    github.getFileContent.mockImplementation((_t, _o, _r, path: string) =>
      Promise.resolve(
        path.endsWith('stale.yml')
          ? staleYaml
          : `alphaci-api-url: ${CURRENT}\n`,
      ),
    );

    await expect(read()).resolves.toEqual([
      {
        path: '.github/workflows/stale.yml',
        content: `alphaci-api-url: ${CURRENT}\n`,
        staleBases: ['http://localhost:4000'],
      },
    ]);
  });
});
