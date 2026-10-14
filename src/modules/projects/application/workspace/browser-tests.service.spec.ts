import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import type { AuditEventPublisher } from '#kernel/events/platform-event-publisher';
import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';
import type { GithubProjectPort } from '#kernel/ports/github.port';
import type { ProjectsRepository } from '../../infrastructure/projects.repository';
import { buildBrowserTestStarterFiles } from '../../scaffolds/browser-test-starter';
import type { ProjectGithubTokenResolver } from '../github-activity/project-github-token.resolver';
import { BrowserTestsService } from './browser-tests.service';

const REPO = 'Alpha-Explora/shop-web';
const STARTER = buildBrowserTestStarterFiles().map((file) => file.path);
const FRONTEND_PKG =
  JSON.stringify({ name: 'shop', dependencies: { next: '^15.0.0' } }, null, 2) +
  '\n';

type Files = Record<string, string | true>;

/** A repository whose dev branch holds exactly `files`. */
function build(
  opts: {
    files?: Files;
    devBranch?: boolean;
    role?: PlatformAppRole;
    row?: unknown;
    takenBranches?: string[];
    openPrs?: object[];
    commit?: unknown;
    pr?: unknown;
  } = {},
) {
  const files: Files = opts.files ?? { 'package.json': FRONTEND_PKG };
  const taken = new Set(opts.takenBranches ?? []);
  const github = {
    branchExists: jest.fn((_t: string, _o: string, _r: string, b: string) =>
      Promise.resolve(b === 'dev' ? opts.devBranch !== false : taken.has(b)),
    ),
    readRepoFiles: jest.fn(
      (_t: string, _r: string, _ref: string, paths: string[]) =>
        Promise.resolve({
          read: true,
          files: Object.fromEntries(
            paths.map((p) => [
              p,
              {
                exists: p in files,
                content: typeof files[p] === 'string' ? files[p] : null,
              },
            ]),
          ),
        }),
    ),
    listPullRequests: jest.fn(() => Promise.resolve(opts.openPrs ?? [])),
    commitFilesToNewBranch: jest.fn(() =>
      Promise.resolve(opts.commit ?? { committed: true, commitSha: 'c1' }),
    ),
    openPullRequest: jest.fn(() =>
      Promise.resolve(
        opts.pr ?? { created: true, pullRequest: { number: 42 } },
      ),
    ),
  };
  const repository = {
    findByIdAndUser: jest.fn(() =>
      Promise.resolve('row' in opts ? opts.row : { repo_full_name: REPO }),
    ),
    findAppRole: jest.fn(() => Promise.resolve(opts.role ?? 'member')),
  };
  const tokens = {
    installationFirst: jest.fn(() => Promise.resolve('ghs_read')),
  };
  const record = jest.fn(() => Promise.resolve());
  const service = new BrowserTestsService(
    repository as unknown as ProjectsRepository,
    github as unknown as GithubProjectPort,
    tokens as unknown as ProjectGithubTokenResolver,
    { recordProjectEvent: record } as unknown as AuditEventPublisher,
  );
  return { service, github, record };
}

const caught = (p: Promise<unknown>) => p.catch((e: unknown) => e);

describe('BrowserTestsService.getStatus', () => {
  it('reports a repository with the whole pack as installed', async () => {
    const files: Files = { 'package.json': FRONTEND_PKG, 'yarn.lock': true };
    for (const path of STARTER) files[path] = true;
    const { service } = build({ files });
    const status = await service.getStatus('p', 'u', 'gho');
    expect(status).toMatchObject({
      installed: true,
      branch: 'dev',
      missingFiles: [],
      hasLockfile: true,
      frontend: true,
      canAdd: true,
      reason: null,
    });
  });

  it('reports a partial install with the missing files and the playwright range', async () => {
    const pkg = JSON.stringify({
      dependencies: { react: '19' },
      devDependencies: { '@playwright/test': '^1.49.0' },
    });
    const { service } = build({
      files: {
        'package.json': pkg,
        'tests/e2e/pages.e2e-spec.ts': true,
        'tests/e2e/support.ts': true,
      },
    });
    const status = await service.getStatus('p', 'u', 'gho');
    expect(status.installed).toBe(false);
    expect(status.presentFiles).toEqual([
      'tests/e2e/pages.e2e-spec.ts',
      'tests/e2e/support.ts',
    ]);
    expect(status.missingFiles).toContain('tests/e2e/visual.e2e-spec.ts');
    expect(status.hasLockfile).toBe(false);
    expect(status.playwrightVersion).toBe('^1.49.0');
    expect(status.canAdd).toBe(true);
  });

  describe('visual testing flag', () => {
    const VERIFY = '.github/workflows/30-alphaci-verify.yml';
    const WIRED = [
      'jobs:',
      '  ui-tests-uat:',
      '    uses: o/r/.github/workflows/playwright-e2e.yml@v1',
      '    with:',
      '      visual-baselines: true',
      '      alphaci-api-url: https://alphaci.example.com',
      '    secrets:',
      '      ALPHACI_TOKEN: ${{ secrets.ALPHACI_TOKEN }}',
      '',
    ].join('\n');
    const OLD = [
      'jobs:',
      '  ui-tests-uat:',
      '    uses: o/r/.github/workflows/playwright-e2e.yml@v1',
      '    with:',
      '      e2e-tests-directory: tests/e2e',
      '',
    ].join('\n');

    const probe = (path: string, content: string | undefined) =>
      path === 'package.json'
        ? { exists: true, content: FRONTEND_PKG }
        : path === VERIFY
          ? { exists: content !== undefined, content: content ?? null }
          : { exists: false, content: null };

    /** Serve a different verify workflow per branch; everything else empty. */
    function perBranch(byBranch: Record<string, string | undefined>) {
      const made = build();
      made.github.readRepoFiles.mockImplementation(
        (_t: string, _r: string, ref: string, paths: string[]) =>
          Promise.resolve({
            read: true,
            files: Object.fromEntries(
              paths.map((p) => [p, probe(p, byBranch[ref])]),
            ),
          }),
      );
      return made;
    }

    it('reports each branch separately: on for dev, off for uat', async () => {
      const { service } = perBranch({ dev: WIRED, uat: OLD });
      const status = await service.getStatus('p', 'u', 'gho');
      expect(status.visual).toEqual({ dev: true, uat: false });
    });

    it('reports null for a branch with no verify workflow', async () => {
      const { service } = perBranch({ dev: WIRED });
      const status = await service.getStatus('p', 'u', 'gho');
      expect(status.visual).toEqual({ dev: true, uat: null });
    });

    it('reports null for a workflow that does not parse', async () => {
      const { service } = perBranch({ dev: 'jobs: [unclosed', uat: ':::' });
      const status = await service.getStatus('p', 'u', 'gho');
      expect(status.visual).toEqual({ dev: null, uat: null });
    });

    it('reads the workflow file named by the project (variant repos)', async () => {
      const made = build({
        row: {
          repo_full_name: REPO,
          workflow_path: '.github/workflows/00-alphaci-access-frontend.yml',
        },
      });
      await made.service.getStatus('p', 'u', 'gho');
      const paths = made.github.readRepoFiles.mock.calls.flatMap(
        (call) => call[3],
      );
      expect(paths).toContain(
        '.github/workflows/30-alphaci-verify-frontend.yml',
      );
    });

    it('never fails the status when the workflow read throws or is unauthorized', async () => {
      const made = build();
      (made.github.readRepoFiles as jest.Mock).mockImplementation(
        (_t: string, _r: string, ref: string, paths: string[]) => {
          if (paths.includes(VERIFY)) {
            return ref === 'dev'
              ? Promise.reject(new Error('GitHub 502'))
              : Promise.resolve({
                  read: false,
                  reason: 'unauthorized',
                  message: 'bad token',
                });
          }
          return Promise.resolve({
            read: true,
            files: Object.fromEntries(
              paths.map((p) => [p, probe(p, undefined)]),
            ),
          });
        },
      );
      const status = await made.service.getStatus('p', 'u', 'gho');
      expect(status.visual).toEqual({ dev: null, uat: null });
      expect(status.frontend).toBe(true);
    });
  });

  it('cannot add to a non-frontend repository', async () => {
    const { service } = build({
      files: { 'package.json': '{"dependencies":{"@nestjs/core":"11"}}' },
    });
    const status = await service.getStatus('p', 'u', 'gho');
    expect(status.canAdd).toBe(false);
    expect(status.frontend).toBe(false);
    expect(status.reason).toMatch(/frontend/);
  });

  it('flags a non-frontend repository even when the role reason is the one reported', async () => {
    // The screen hides the card on `frontend: false`; `reason` reports the
    // role first, so it cannot be used to tell a backend repository apart.
    const { service } = build({
      role: 'qa',
      files: { 'package.json': '{"dependencies":{"@nestjs/core":"11"}}' },
    });
    const status = await service.getStatus('p', 'u', 'gho');
    expect(status.frontend).toBe(false);
    expect(status.reason).toMatch(/role/);
  });

  it('cannot add when there is no dev branch', async () => {
    const { service, github } = build({ devBranch: false });
    const status = await service.getStatus('p', 'u', 'gho');
    expect(status).toMatchObject({ installed: false, canAdd: false });
    expect(status.reason).toMatch(/no dev branch/);
    expect(status.missingFiles).toHaveLength(STARTER.length);
    expect(github.readRepoFiles).not.toHaveBeenCalled();
  });

  it('cannot add for a role outside the allow-list, without failing the read', async () => {
    const { service } = build({ role: 'qa' });
    const status = await service.getStatus('p', 'u', 'gho');
    expect(status.canAdd).toBe(false);
    expect(status.reason).toMatch(/role/);
  });

  it('is a 404 for a project the caller cannot see', async () => {
    const { service } = build({ row: null });
    await expect(service.getStatus('p', 'u', 'gho')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('BrowserTestsService.addBrowserTests', () => {
  it('commits every starter file plus package.json edits when there is no lockfile', async () => {
    const { service, github, record } = build();
    const result = await service.addBrowserTests('p', 'u', 'gho_user');

    expect(result.filesAdded.sort()).toEqual([...STARTER].sort());
    expect(result.filesUpdated).toEqual(['package.json']);
    expect(result.filesSkipped).toEqual([]);
    expect(result).toMatchObject({
      pullRequestNumber: 42,
      branch: 'alphaci/browser-tests',
    });

    // The write uses the signed-in user's token, in ONE commit off dev.
    expect(github.commitFilesToNewBranch).toHaveBeenCalledTimes(1);
    const [token, repo, input] = github.commitFilesToNewBranch.mock
      .calls[0] as unknown as [
      string,
      string,
      { fromBranch: string; files: { path: string; content: string }[] },
    ];
    expect(token).toBe('gho_user');
    expect(repo).toBe(REPO);
    expect(input.fromBranch).toBe('dev');
    const pkg = JSON.parse(
      input.files.find((f) => f.path === 'package.json')!.content,
    ) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies['@axe-core/playwright']).toBe('^4.10.0');

    const prCall = (
      github.openPullRequest.mock.calls[0] as unknown as [
        string,
        string,
        { title: string; base: string; head: string; body: string },
      ]
    )[2];
    expect(prCall).toMatchObject({
      title: 'Add ALPHACI browser tests',
      base: 'dev',
      head: 'alphaci/browser-tests',
    });
    expect(prCall.body).toContain('Nothing else in the application changes.');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCode: 'browser_tests_pull_request_created',
      }),
    );
  });

  it('never overwrites an existing file and does not touch package.json when a lockfile exists', async () => {
    const { service, github } = build({
      files: {
        'package.json': FRONTEND_PKG,
        'package-lock.json': true,
        'tests/e2e/pages.e2e-spec.ts': true,
        'tests/e2e/support.ts': true,
      },
    });
    const result = await service.addBrowserTests('p', 'u', 'gho');

    expect(result.filesSkipped).toEqual(
      expect.arrayContaining([
        'tests/e2e/pages.e2e-spec.ts',
        'tests/e2e/support.ts',
        'package.json',
      ]),
    );
    expect(result.filesUpdated).toEqual([]);
    const committed = (
      github.commitFilesToNewBranch.mock.calls[0] as unknown as [
        string,
        string,
        { files: { path: string }[] },
      ]
    )[2].files.map((f) => f.path);
    expect(committed).not.toContain('package.json');
    expect(committed).not.toContain('tests/e2e/pages.e2e-spec.ts');
    expect(committed).toContain('tests/e2e/visual.e2e-spec.ts');
    expect(result.notes.join(' ')).toMatch(/lockfile/);
  });

  it('keeps an existing playwright.config.ts and says what snapshots need', async () => {
    const { service, github } = build({
      files: { 'package.json': FRONTEND_PKG, 'playwright.config.ts': true },
    });
    const result = await service.addBrowserTests('p', 'u', 'gho');
    expect(result.filesSkipped).toContain('playwright.config.ts');
    expect(result.filesAdded).not.toContain('playwright.config.ts');
    expect(result.notes.join(' ')).toContain(
      "snapshotPathTemplate: '{testDir}/__visual__/{arg}{ext}'",
    );
    const body = (
      github.openPullRequest.mock.calls[0] as unknown as [
        string,
        string,
        { body: string },
      ]
    )[2].body;
    expect(body).toContain('snapshotPathTemplate');
  });

  it('does not downgrade an existing newer playwright when editing package.json', async () => {
    const pkg = JSON.stringify({
      dependencies: { next: '15' },
      scripts: { 'test:e2e': 'playwright test' },
      devDependencies: { '@playwright/test': '^1.70.0' },
    });
    const { service, github } = build({ files: { 'package.json': pkg } });
    await service.addBrowserTests('p', 'u', 'gho');
    const files = (
      github.commitFilesToNewBranch.mock.calls[0] as unknown as [
        string,
        string,
        { files: { path: string; content: string }[] },
      ]
    )[2].files;
    const written = JSON.parse(
      files.find((f) => f.path === 'package.json')!.content,
    ) as { devDependencies: Record<string, string> };
    expect(written.devDependencies['@playwright/test']).toBe('^1.70.0');
  });

  it('moves to alphaci/browser-tests-2 when the first name is taken', async () => {
    const { service } = build({ takenBranches: ['alphaci/browser-tests'] });
    const result = await service.addBrowserTests('p', 'u', 'gho');
    expect(result.branch).toBe('alphaci/browser-tests-2');
  });

  it('moves on when GitHub reports the branch taken during the commit', async () => {
    const { service, github } = build();
    github.commitFilesToNewBranch
      .mockResolvedValueOnce({
        committed: false,
        reason: 'branch_exists',
        message: 'x',
      } as never)
      .mockResolvedValueOnce({ committed: true, commitSha: 'c2' } as never);
    const result = await service.addBrowserTests('p', 'u', 'gho');
    expect(result.branch).toBe('alphaci/browser-tests-2');
  });

  it('returns the already-open pull request as a 409 instead of opening another', async () => {
    const { service, github } = build({
      openPrs: [
        { number: 9, headRef: 'alphaci/browser-tests-2', baseRef: 'dev' },
        { number: 3, headRef: 'feature/x', baseRef: 'dev' },
      ],
    });
    const error = (await caught(
      service.addBrowserTests('p', 'u', 'gho'),
    )) as ConflictException;
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({
      code: 'BROWSER_TESTS_PR_OPEN',
      pullRequestNumber: 9,
      branch: 'alphaci/browser-tests-2',
    });
    expect(github.commitFilesToNewBranch).not.toHaveBeenCalled();
  });

  it('refuses qa, and any role outside the allow-list, with a code', async () => {
    for (const role of ['qa'] as PlatformAppRole[]) {
      const { service, github } = build({ role });
      const error = (await caught(
        service.addBrowserTests('p', 'u', 'gho'),
      )) as ForbiddenException;
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getResponse()).toMatchObject({
        code: 'BROWSER_TESTS_ROLE_FORBIDDEN',
      });
      expect(github.listPullRequests).not.toHaveBeenCalled();
    }
  });

  it.each(['admin', 'lead', 'member'] as PlatformAppRole[])(
    'allows %s',
    async (role) => {
      const { service } = build({ role });
      await expect(
        service.addBrowserTests('p', 'u', 'gho'),
      ).resolves.toMatchObject({
        pullRequestNumber: 42,
      });
    },
  );

  it('asks to sign in again (GITHUB_REAUTH) without a session token', async () => {
    const { service, github } = build();
    const error = (await caught(
      service.addBrowserTests('p', 'u', null),
    )) as ConflictException;
    expect(error.getResponse()).toMatchObject({ code: 'GITHUB_REAUTH' });
    expect(github.commitFilesToNewBranch).not.toHaveBeenCalled();
  });

  it('maps a GitHub 401 on the commit to GITHUB_REAUTH', async () => {
    const { service } = build({
      commit: { committed: false, reason: 'unauthorized', message: 'no' },
    });
    const error = (await caught(
      service.addBrowserTests('p', 'u', 'gho'),
    )) as ConflictException;
    expect(error.getResponse()).toMatchObject({ code: 'GITHUB_REAUTH' });
  });

  it('maps a GitHub 401 on the read to GITHUB_REAUTH', async () => {
    const { service, github } = build();
    github.readRepoFiles.mockResolvedValueOnce({
      read: false,
      reason: 'unauthorized',
      message: 'no',
    } as never);
    const error = (await caught(
      service.addBrowserTests('p', 'u', 'gho'),
    )) as ConflictException;
    expect(error.getResponse()).toMatchObject({ code: 'GITHUB_REAUTH' });
  });

  it('refuses a non-frontend repository and an empty plan', async () => {
    const backend = build({
      files: { 'package.json': '{"dependencies":{"express":"5"}}' },
    });
    await expect(
      backend.service.addBrowserTests('p', 'u', 'gho'),
    ).rejects.toMatchObject({
      response: { code: 'BROWSER_TESTS_NOT_FRONTEND' },
    });

    const files: Files = {
      'package.json': FRONTEND_PKG,
      'package-lock.json': true,
    };
    for (const path of STARTER) files[path] = true;
    const done = build({ files });
    await expect(
      done.service.addBrowserTests('p', 'u', 'gho'),
    ).rejects.toMatchObject({
      response: { code: 'BROWSER_TESTS_NOTHING_TO_ADD' },
    });
  });

  it('does not publish an audit event when the pull request is refused', async () => {
    const { service, record } = build({
      pr: { created: false, message: 'nope' },
    });
    await expect(
      service.addBrowserTests('p', 'u', 'gho'),
    ).rejects.toMatchObject({
      response: { code: 'BROWSER_TESTS_PR_REFUSED' },
    });
    expect(record).not.toHaveBeenCalled();
  });
});
