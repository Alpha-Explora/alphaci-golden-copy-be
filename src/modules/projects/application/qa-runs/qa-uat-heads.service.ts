import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { QA_BRANCH } from '#kernel/config/pipeline-branches';
import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import type { QaProjectRepository } from '../qa-checklists/qa-project-context.service';

export interface QaHeadsActor {
  userId: string;
  oauthToken: string | null;
}

export interface ReadHeadOptions {
  /**
   * Reuse a reading of the same repository taken less than this many ms ago.
   * For display paths only (a run view re-reads on every item write); the
   * merge gate and run creation always read fresh.
   */
  maxAgeMs?: number;
}

/** Which credential a QA-flow GitHub write was made with. */
export type QaWriteVia = 'github_app' | 'user_token';

export interface QaWriteCredential {
  token: string;
  via: QaWriteVia;
}

/** What reading one repository's uat head came to. */
export type QaUatHeadReading =
  | { kind: 'ok'; repository: QaProjectRepository; sha: string }
  | { kind: 'branch_missing'; repository: QaProjectRepository }
  | { kind: 'unreadable'; repository: QaProjectRepository };

/**
 * Server-authoritative reading of the uat head of every repository of a
 * Project (ADR-0013 rule 4: the client never sends a SHA). Reads in parallel
 * with the same three-tier token precedence the per-repository gate always
 * used: the enforced-org installation token, then the per-user-repo
 * installation token, then the caller's own OAuth token. A caller with no
 * personal GitHub sign-in still sees the gate through an installation token.
 */
@Injectable()
export class QaUatHeadsService {
  private readonly logger = new Logger(QaUatHeadsService.name);
  private readonly recent = new Map<
    string,
    { at: number; reading: { sha: string | null } }
  >();

  constructor(
    @Inject(GITHUB_PROJECT_PORT)
    private readonly githubService: GithubProjectPort,
  ) {}

  async readHeads(
    repositories: readonly QaProjectRepository[],
    actor: QaHeadsActor,
    options: ReadHeadOptions = {},
  ): Promise<QaUatHeadReading[]> {
    return Promise.all(
      repositories.map((repository) =>
        this.readHead(repository, actor, options),
      ),
    );
  }

  async readHead(
    repository: QaProjectRepository,
    actor: QaHeadsActor,
    options: ReadHeadOptions = {},
  ): Promise<QaUatHeadReading> {
    const cached = options.maxAgeMs
      ? this.recent.get(repository.repoFullName.toLowerCase())
      : undefined;
    if (cached && Date.now() - cached.at < (options.maxAgeMs ?? 0)) {
      return cached.reading.sha
        ? { kind: 'ok', repository, sha: cached.reading.sha }
        : { kind: 'branch_missing', repository };
    }
    const reading = await this.readHeadFresh(repository, actor);
    if (reading.kind !== 'unreadable') {
      this.recent.set(repository.repoFullName.toLowerCase(), {
        at: Date.now(),
        reading: { sha: reading.kind === 'ok' ? reading.sha : null },
      });
    }
    return reading;
  }

  private async readHeadFresh(
    repository: QaProjectRepository,
    actor: QaHeadsActor,
  ): Promise<QaUatHeadReading> {
    try {
      const token = await this.resolveReadToken(
        repository.repoFullName,
        actor.userId,
        actor.oauthToken,
      );
      if (!token) {
        return { kind: 'unreadable', repository };
      }
      const branches = await this.githubService.listBranches(
        token,
        repository.repoFullName,
      );
      const head = branches.find((candidate) => candidate.name === QA_BRANCH);
      return head?.commitSha
        ? { kind: 'ok', repository, sha: head.commitSha }
        : { kind: 'branch_missing', repository };
    } catch (error) {
      this.logger.warn(
        `Could not read the ${QA_BRANCH} head of ${repository.repoFullName}: ${(error as Error).message}`,
      );
      return { kind: 'unreadable', repository };
    }
  }

  /** The token used to read `repoFullName`, or null when none is available. */
  async resolveReadToken(
    repoFullName: string,
    userId: string,
    oauthToken: string | null,
  ): Promise<string | null> {
    return (
      (await this.resolveInstallationToken(repoFullName, userId)) ?? oauthToken
    );
  }

  /**
   * The GitHub App installation token for `repoFullName` (enforced-org
   * installation, then the caller's per-user-repo installation), or null.
   */
  async resolveInstallationToken(
    repoFullName: string,
    userId: string,
  ): Promise<string | null> {
    const enforcedToken = await this.enforcedOrgToken(repoFullName);
    if (enforcedToken) {
      return enforcedToken;
    }

    try {
      return await this.githubService.getInstallationAccessTokenForUserRepo(
        userId,
        repoFullName,
      );
    } catch (error) {
      this.logger.debug(
        `No installation token for ${repoFullName}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * The credential for a QA-flow GitHub WRITE (Run Playwright, Merge to
   * main). Callers run ALPHACI's own role / visibility / gate checks first;
   * the write then goes out as the ALPHACI GitHub App because the default
   * repository permission is read, so a person's own OAuth token cannot
   * dispatch or merge. The person's token is only the fallback when no
   * installation resolves. `via` is recorded in the audit event; the person
   * stays named by actorUserId.
   */
  async resolveWriteCredential(
    repoFullName: string,
    userId: string,
    oauthToken: string | null,
  ): Promise<QaWriteCredential | null> {
    const installation = await this.resolveInstallationToken(
      repoFullName,
      userId,
    );
    if (installation) {
      return { token: installation, via: 'github_app' };
    }
    return oauthToken ? { token: oauthToken, via: 'user_token' } : null;
  }

  private async enforcedOrgToken(repoFullName: string): Promise<string | null> {
    const enforcedOrg = this.githubService.getEnforcedOrg();
    if (!enforcedOrg) {
      return null;
    }

    const owner = repoFullName.split('/')[0];
    if (owner?.toLowerCase() !== enforcedOrg.toLowerCase()) {
      return null;
    }

    try {
      const context =
        await this.githubService.getOrganizationProvisioningContextByLogin(
          enforcedOrg,
        );
      return context.accessToken;
    } catch (error) {
      this.logger.warn(
        `Could not resolve the ${enforcedOrg} installation for ${repoFullName}: ${(error as Error).message}`,
      );
      return null;
    }
  }
}

/**
 * sha256 hex of the sorted "<provisioned_project_id>:<head_sha>" lines: the
 * idempotency key of a Project run. Order-independent, so the same set of
 * heads always yields the same fingerprint.
 */
export function fingerprintHeads(
  heads: ReadonlyArray<{ projectId: string; headSha: string }>,
): string {
  const lines = heads
    .map((head) => `${head.projectId}:${head.headSha}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(lines, 'utf8').digest('hex');
}
