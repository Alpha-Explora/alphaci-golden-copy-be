import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { WORKING_BRANCH } from '#kernel/config/pipeline-branches';
import { AuditEventPublisher } from '#kernel/events/platform-event-publisher';
import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import { canAddBrowserTests } from '#kernel/rules/persona-access.rules';
import { ProjectsRepository } from '../../infrastructure/projects.repository';
import {
  BROWSER_TEST_REQUIRED_PATHS,
  PLAYWRIGHT_CONFIG_PATH,
  SNAPSHOT_CONFIG_SNIPPET,
  buildBrowserTestStarterFiles,
} from '../../scaffolds/browser-test-starter';
import { ProjectGithubTokenResolver } from '../github-activity/project-github-token.resolver';
import {
  isFrontendPackage,
  readPlaywrightVersion,
  updatePackageJson,
} from './browser-tests.package-json';

const PACKAGE_JSON = 'package.json';
const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'] as const;
const BRANCH_BASE = 'alphaci/browser-tests';
const PR_TITLE = 'Add ALPHACI browser tests';
/** Branch names tried (alphaci/browser-tests, -2, -3 ...) before giving up. */
const MAX_BRANCH_ATTEMPTS = 10;

/** GET workspace/browser-tests */
export interface BrowserTestsStatusResponse {
  installed: boolean;
  branch: string;
  missingFiles: string[];
  presentFiles: string[];
  hasLockfile: boolean;
  playwrightVersion: string | null;
  /**
   * Whether package.json has a Next.js or React dependency. Explicit so the
   * screen never infers it from `reason`'s wording, which also reports the
   * role or a missing dev branch first.
   */
  frontend: boolean;
  canAdd: boolean;
  reason: string | null;
}

/** POST workspace/browser-tests */
export interface BrowserTestsAddResponse {
  pullRequestNumber: number;
  branch: string;
  /** Files created by the pull request. */
  filesAdded: string[];
  /** Existing files edited (package.json only, and only without a lockfile). */
  filesUpdated: string[];
  /** Files that already existed (or were left alone) and were NOT touched. */
  filesSkipped: string[];
  /** Plain sentences about what was left alone and why. */
  notes: string[];
}

interface RepoInspection {
  devBranchFound: boolean;
  presentFiles: string[];
  missingFiles: string[];
  hasLockfile: boolean;
  packageJson: string | null;
}

const STARTER_PATHS = [
  PLAYWRIGHT_CONFIG_PATH,
  ...BROWSER_TEST_REQUIRED_PATHS,
] as const;

function reauth(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'GITHUB_REAUTH',
    message: 'Sign in to GitHub again, then retry.',
  });
}

/**
 * "Add browser tests" for a project that already exists: reports whether the
 * starter pack is on its dev branch, and opens a pull request adding what is
 * missing.
 *
 * Reads go through the same credential order as every other workspace read.
 * The write is the signed-in person's own GitHub token and nothing else, so
 * the pull request is theirs and GitHub judges whether they may open it.
 */
@Injectable()
export class BrowserTestsService {
  constructor(
    private readonly projectsRepository: ProjectsRepository,
    @Inject(GITHUB_PROJECT_PORT)
    private readonly github: GithubProjectPort,
    private readonly tokens: ProjectGithubTokenResolver,
    // Explicit token: see qa-promotion.service.ts - without it @Optional()
    // silently injects undefined.
    @Optional()
    @Inject(AuditEventPublisher)
    private readonly audit?: AuditEventPublisher,
  ) {}

  async getStatus(
    projectId: string,
    userId: string,
    oauthToken: string | null,
  ): Promise<BrowserTestsStatusResponse> {
    const repoFullName = await this.requireRepo(projectId, userId);
    const role = await this.projectsRepository.findAppRole(userId);

    const token = await this.tokens.installationFirst(
      repoFullName,
      userId,
      oauthToken,
    );
    if (!token) {
      throw new UnauthorizedException(
        'No usable GitHub token found. Link the GitHub App installation or re-authenticate via GitHub OAuth.',
      );
    }

    const found = await this.inspect(token, repoFullName);
    const frontend = isFrontendPackage(found.packageJson);

    let reason: string | null = null;
    if (!canAddBrowserTests(role)) {
      reason = 'Your role cannot add browser tests to this project.';
    } else if (!found.devBranchFound) {
      reason = `This repository has no ${WORKING_BRANCH} branch yet, and browser tests are added there.`;
    } else if (!frontend) {
      reason =
        'This repository does not look like a frontend project (no Next.js or React dependency in package.json).';
    }

    return {
      installed: BROWSER_TEST_REQUIRED_PATHS.every((path) =>
        found.presentFiles.includes(path),
      ),
      branch: WORKING_BRANCH,
      missingFiles: found.missingFiles,
      presentFiles: found.presentFiles,
      hasLockfile: found.hasLockfile,
      playwrightVersion: readPlaywrightVersion(found.packageJson),
      frontend,
      canAdd: reason === null,
      reason,
    };
  }

  async addBrowserTests(
    projectId: string,
    userId: string,
    oauthToken: string | null,
  ): Promise<BrowserTestsAddResponse> {
    const repoFullName = await this.requireRepo(projectId, userId);

    const role = await this.projectsRepository.findAppRole(userId);
    if (!canAddBrowserTests(role)) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'BROWSER_TESTS_ROLE_FORBIDDEN',
        message: 'Your role cannot add browser tests to this project.',
      });
    }

    // No installation-token fallback: the pull request must be the person's.
    if (!oauthToken) {
      throw reauth();
    }
    const token = oauthToken;

    // Idempotency: an open ALPHACI browser-tests pull request is returned
    // (409 with its number) rather than duplicated.
    const open = await this.github.listPullRequests(
      token,
      repoFullName,
      'open',
      50,
    );
    const existing = open.find(
      (pr) =>
        pr.headRef.startsWith(BRANCH_BASE) && pr.baseRef === WORKING_BRANCH,
    );
    if (existing) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'BROWSER_TESTS_PR_OPEN',
        message: `A browser-tests pull request (#${String(existing.number)}) is already open.`,
        pullRequestNumber: existing.number,
        branch: existing.headRef,
      });
    }

    const found = await this.inspect(token, repoFullName);
    if (!found.devBranchFound) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'BROWSER_TESTS_NO_DEV_BRANCH',
        message: `This repository has no ${WORKING_BRANCH} branch yet.`,
      });
    }
    if (!isFrontendPackage(found.packageJson)) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        code: 'BROWSER_TESTS_NOT_FRONTEND',
        message:
          'This repository does not look like a frontend project (no Next.js or React dependency in package.json).',
      });
    }

    // Plan: only what is MISSING is written; nothing existing is overwritten.
    const filesAdded: string[] = [];
    const filesUpdated: string[] = [];
    const filesSkipped: string[] = [];
    const notes: string[] = [];
    const toCommit: { path: string; content: string }[] = [];

    for (const file of buildBrowserTestStarterFiles()) {
      if (found.presentFiles.includes(file.path)) {
        filesSkipped.push(file.path);
      } else {
        filesAdded.push(file.path);
        toCommit.push(file);
      }
    }

    const configExists = found.presentFiles.includes(PLAYWRIGHT_CONFIG_PATH);
    if (configExists) {
      notes.push(
        `${PLAYWRIGHT_CONFIG_PATH} already exists and was not modified. Visual snapshots need this in its config:\n\n\`\`\`ts\n${SNAPSHOT_CONFIG_SNIPPET}\n\`\`\``,
      );
    }

    if (found.hasLockfile) {
      filesSkipped.push(PACKAGE_JSON);
      notes.push(
        'A lockfile exists, so package.json was left untouched. The verify workflow installs the test packages at run time without changing the lockfile.',
      );
    } else if (found.packageJson !== null) {
      const update = updatePackageJson(found.packageJson);
      if (update === null) {
        filesSkipped.push(PACKAGE_JSON);
        notes.push(
          'package.json could not be parsed as JSON, so it was left untouched.',
        );
      } else if (update.changed) {
        filesUpdated.push(PACKAGE_JSON);
        toCommit.push({ path: PACKAGE_JSON, content: update.content });
      }
    }

    if (toCommit.length === 0) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'BROWSER_TESTS_NOTHING_TO_ADD',
        message: 'The browser tests are already in this repository.',
      });
    }

    const body = buildPullRequestBody({
      filesAdded,
      filesUpdated,
      filesSkipped,
      notes,
    });

    // Branch name: alphaci/browser-tests, then -2, -3 ... A lost race on the
    // ref (branch_exists) moves on to the next name as well.
    let branch: string | null = null;
    for (let attempt = 1; attempt <= MAX_BRANCH_ATTEMPTS; attempt += 1) {
      const candidate =
        attempt === 1 ? BRANCH_BASE : `${BRANCH_BASE}-${String(attempt)}`;
      const [owner = '', repo = ''] = repoFullName.split('/');
      if (await this.github.branchExists(token, owner, repo, candidate)) {
        continue;
      }
      const result = await this.github.commitFilesToNewBranch(
        token,
        repoFullName,
        {
          fromBranch: WORKING_BRANCH,
          newBranch: candidate,
          message: 'test: add ALPHACI browser tests',
          files: toCommit,
        },
      );
      if (result.committed) {
        branch = candidate;
        break;
      }
      if (result.reason === 'branch_exists') continue;
      if (result.reason === 'unauthorized') throw reauth();
      if (result.reason === 'forbidden') {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'GITHUB_WRITE_FORBIDDEN',
          message: result.message,
        });
      }
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'BROWSER_TESTS_NO_DEV_BRANCH',
        message: result.message,
      });
    }
    if (!branch) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'BROWSER_TESTS_BRANCH_TAKEN',
        message: `Could not find a free ${BRANCH_BASE} branch name. Delete an old one and retry.`,
      });
    }

    const pr = await this.github.openPullRequest(token, repoFullName, {
      title: PR_TITLE,
      head: branch,
      base: WORKING_BRANCH,
      body,
    });
    if (!pr.created) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'BROWSER_TESTS_PR_REFUSED',
        message: `The files were committed to ${branch}, but GitHub refused the pull request: ${pr.message}`,
        branch,
      });
    }

    await this.audit?.recordProjectEvent({
      actorUserId: userId,
      projectId,
      eventCode: 'browser_tests_pull_request_created',
      message: `Pull request #${String(pr.pullRequest.number)} opened to add ALPHACI browser tests`,
      metadata: {
        pullRequestNumber: pr.pullRequest.number,
        branch,
        base: WORKING_BRANCH,
        filesAdded,
        filesUpdated,
        filesSkipped,
      },
    });

    return {
      pullRequestNumber: pr.pullRequest.number,
      branch,
      filesAdded,
      filesUpdated,
      filesSkipped,
      notes,
    };
  }

  private async requireRepo(
    projectId: string,
    userId: string,
  ): Promise<string> {
    const row = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!row) {
      throw new NotFoundException('Project not found');
    }
    return row.repo_full_name;
  }

  /** What the working branch already has, in one parallel read. */
  private async inspect(
    token: string,
    repoFullName: string,
  ): Promise<RepoInspection> {
    const [owner = '', repo = ''] = repoFullName.split('/');
    if (!(await this.github.branchExists(token, owner, repo, WORKING_BRANCH))) {
      return {
        devBranchFound: false,
        presentFiles: [],
        missingFiles: [...STARTER_PATHS],
        hasLockfile: false,
        packageJson: null,
      };
    }

    const result = await this.github.readRepoFiles(
      token,
      repoFullName,
      WORKING_BRANCH,
      [...STARTER_PATHS, PACKAGE_JSON, ...LOCKFILES],
    );
    if (!result.read) {
      throw reauth();
    }

    const exists = (path: string): boolean =>
      result.files[path]?.exists === true;
    return {
      devBranchFound: true,
      presentFiles: STARTER_PATHS.filter(exists),
      missingFiles: STARTER_PATHS.filter((path) => !exists(path)),
      hasLockfile: LOCKFILES.some(exists),
      packageJson: result.files[PACKAGE_JSON]?.content ?? null,
    };
  }
}

/** The pull request description: what, why, and what was left alone. */
function buildPullRequestBody(input: {
  filesAdded: string[];
  filesUpdated: string[];
  filesSkipped: string[];
  notes: string[];
}): string {
  const list = (items: string[]): string =>
    items.map((item) => `- \`${item}\``).join('\n');
  const sections = [
    'Adds the ALPHACI starter browser tests. They run in the verify stage against the deployed site.',
    [
      '## The four checks',
      '',
      '- **Pages**: each route in `PAGES` answers with a success status and logs no console or uncaught errors.',
      '- **Links**: every same-origin link on the home page (up to 25) resolves.',
      '- **Accessibility**: no critical or serious axe-core violations on each route in `PAGES`.',
      '- **Visual**: the home page at desktop (1280x800) and mobile (390x844) matches its approved screenshot.',
    ].join('\n'),
    [
      '## Visual approval',
      '',
      'The first verify run has no baseline screenshots, so it records them. Review and approve them in ALPHACI; later runs compare against what was approved and fail on a visual change.',
    ].join('\n'),
    'Add your own routes to `PAGES` in `tests/e2e/support.ts` as the app grows.',
  ];
  if (input.filesAdded.length > 0) {
    sections.push(`## Files added\n\n${list(input.filesAdded)}`);
  }
  if (input.filesUpdated.length > 0) {
    sections.push(
      `## Files updated\n\n${list(input.filesUpdated)}\n\nOnly the test devDependencies and the \`test:e2e\` script were added; no existing version was downgraded.`,
    );
  }
  if (input.filesSkipped.length > 0) {
    sections.push(
      `## Already present, not changed\n\n${list(input.filesSkipped)}`,
    );
  }
  if (input.notes.length > 0) {
    sections.push(`## Notes\n\n${input.notes.join('\n\n')}`);
  }
  sections.push('Nothing else in the application changes.');
  return sections.join('\n\n');
}
