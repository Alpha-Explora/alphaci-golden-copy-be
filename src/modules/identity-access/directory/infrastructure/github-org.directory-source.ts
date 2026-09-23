import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import {
  GITHUB_ORGANIZATION_PORT,
  type GithubOrganizationPort,
} from '#kernel/ports/github.port';
import { MemberDirectorySource } from '../application/member-directory.source';
import type {
  DirectoryCaller,
  DirectoryDescription,
  DirectoryPerson,
  DirectoryRead,
} from '../domain/directory.types';

/**
 * The picker searches as the lead types, and every search re-reads the
 * roster. A short cache keeps that to one GitHub call per minute per org,
 * while a member added on GitHub still shows up within a minute.
 */
export const ROSTER_CACHE_TTL_MS = 60_000;

/** The directory is the membership of one GitHub organization. */
@Injectable()
export class GithubOrgDirectorySource extends MemberDirectorySource {
  private readonly organization: string;
  private cached: { at: number; people: DirectoryPerson[] } | null = null;

  constructor(
    configService: ConfigService,
    @Inject(GITHUB_ORGANIZATION_PORT)
    private readonly github: GithubOrganizationPort,
  ) {
    super();
    this.organization =
      configService.getOrThrow<AppConfig>('app').directory.organization;
  }

  describe(): DirectoryDescription {
    return { source: 'github_org', organization: this.organization || null };
  }

  async read(caller: DirectoryCaller): Promise<DirectoryRead> {
    const org = this.organization;
    if (!org) {
      return {
        kind: 'unavailable',
        reason:
          'No GitHub organization is configured for the member directory. Set MEMBER_DIRECTORY_ORG or GITHUB_ENFORCED_ORG.',
      };
    }

    if (this.cached && Date.now() - this.cached.at < ROSTER_CACHE_TTL_MS) {
      return { kind: 'ok', people: this.cached.people };
    }

    const members = await this.github.readOrganizationMembers({
      org,
      userId: caller.userId,
      userToken: caller.githubToken,
    });
    if (members === null) {
      return {
        kind: 'unavailable',
        reason: `The ${org} GitHub organization could not be read. Sign out and sign in again to refresh your GitHub access, or install the GitHub App on ${org}.`,
      };
    }

    this.cached = { at: Date.now(), people: members };
    return { kind: 'ok', people: members };
  }
}
