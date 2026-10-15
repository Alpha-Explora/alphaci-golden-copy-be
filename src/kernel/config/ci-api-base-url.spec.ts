import type { GithubProjectPort } from '#kernel/ports/github.port';

import {
  findStaleCiWorkflowFiles,
  isReachableFromGithubRunners,
  normalizeOrigin,
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

describe('isReachableFromGithubRunners', () => {
  it.each([
    'http://localhost:4000',
    'https://localhost:4000',
    'https://127.0.0.1',
    'https://[::1]',
    'https://api.localhost',
    'http://dev-api.alphaci.com.ph',
  ])('refuses %s', (base) => {
    expect(isReachableFromGithubRunners(base)).toBe(false);
  });

  it('accepts a public HTTPS address', () => {
    expect(isReachableFromGithubRunners(CURRENT)).toBe(true);
  });
});

describe('normalizeOrigin', () => {
  it('lower-cases the origin and drops the default port and any slash', () => {
    expect(normalizeOrigin('HTTPS://Dev-API.alphaci.com.ph:443/')).toBe(
      CURRENT,
    );
    expect(normalizeOrigin('http://localhost:80')).toBe('http://localhost');
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

  it('replaces every AlphaCI API base the generator writes: keyed values, URLs and the reusable input', () => {
    const content = [
      "      ALPHACI_VALIDATE_URL: 'http://localhost:4000/api/v1/ci/validate'",
      '      ALPHACI_REPORT_URL: http://localhost:4000/api/v1/ci/report',
      "        'alphaci-api-url': http://localhost:4000",
      '          ALPHACI_API_URL: http://localhost:4000',
      '          api-url: http://localhost:4000',
      '      uses: Alpha-Explora/central@v1',
    ].join('\n');

    const result = rewriteCiApiBase(content, CURRENT);

    expect(result.content).toBe(
      [
        `      ALPHACI_VALIDATE_URL: '${CURRENT}/api/v1/ci/validate'`,
        `      ALPHACI_REPORT_URL: ${CURRENT}/api/v1/ci/report`,
        `        'alphaci-api-url': ${CURRENT}`,
        `          ALPHACI_API_URL: ${CURRENT}`,
        `          api-url: ${CURRENT}`,
        '      uses: Alpha-Explora/central@v1',
      ].join('\n'),
    );
    expect(result.staleBases).toEqual(['http://localhost:4000']);
  });

  it('replaces every occurrence of a stale base once the file has shown it is stale', () => {
    const content = [
      '          ALPHACI_API_URL: http://localhost:4000',
      '        run: echo http://localhost:4000 >> out.txt',
    ].join('\n');

    expect(rewriteCiApiBase(content, CURRENT).content).toBe(
      [
        `          ALPHACI_API_URL: ${CURRENT}`,
        `        run: echo ${CURRENT} >> out.txt`,
      ].join('\n'),
    );
  });

  it('does not flag or rewrite a whole-line comment', () => {
    const content = '# ALPHACI_API_URL: http://localhost:4000\n';

    expect(rewriteCiApiBase(content, CURRENT)).toEqual({
      content,
      staleBases: [],
    });
  });

  it('never hardcodes a base that is an expression', () => {
    const content = [
      '          ALPHACI_VALIDATE_URL: https://${{ vars.HOST }}/api/v1/ci/validate',
      '          api-url: https://${{ vars.HOST }}',
    ].join('\n');

    expect(rewriteCiApiBase(content, CURRENT)).toEqual({
      content,
      staleBases: [],
    });
  });

  it('keeps the first URL on a line when the second is the stale API', () => {
    const content =
      'ref: http://a.example/x,https://b.example/api/v1/ci/report\n';

    expect(rewriteCiApiBase(content, CURRENT)).toEqual({
      content: `ref: http://a.example/x,${CURRENT}/api/v1/ci/report\n`,
      staleBases: ['https://b.example'],
    });
  });

  it('treats a default port as the same base', () => {
    const content = `          ALPHACI_API_URL: ${CURRENT}:443\n`;

    expect(rewriteCiApiBase(content, CURRENT)).toEqual({
      content,
      staleBases: [],
    });
  });

  it('does not rewrite a different port that only starts the same way', () => {
    const content = [
      '          ALPHACI_API_URL: http://localhost:4000',
      '        run: curl http://localhost:40001/health',
    ].join('\n');

    expect(rewriteCiApiBase(content, CURRENT).content).toBe(
      [
        `          ALPHACI_API_URL: ${CURRENT}`,
        '        run: curl http://localhost:40001/health',
      ].join('\n'),
    );
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

  it('reads no files on a ref that does not exist', async () => {
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
