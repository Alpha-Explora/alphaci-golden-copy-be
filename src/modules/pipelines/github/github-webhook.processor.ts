import { createHmac, timingSafeEqual } from 'node:crypto';

import { Logger, UnauthorizedException } from '@nestjs/common';

import type { GithubRepositoryDeletedEvent } from '#kernel/ports/github.port';
import type { GithubInstallationsRepository } from './github-installations.repository';

/**
 * Emitted on GithubService when a GitHub `repository` webhook reports
 * `action: 'deleted'`. ProjectsService subscribes to this in its constructor
 * to mark the matching provisioned_projects row 'orphaned' — see the
 * module-level comment on that subscription for why an event is used
 * instead of a direct repository injection (GithubModule must not import
 * ProjectsModule, which a direct ProjectsRepository/ProjectsService
 * dependency here would require).
 */
export const REPOSITORY_DELETED_EVENT = 'repository.deleted';

export type RepositoryDeletedEvent = GithubRepositoryDeletedEvent;

/**
 * Emitted when a GitHub `membership` webhook reports someone being added to or
 * removed from an org team. GithubTeamRoleService subscribes to re-derive that
 * user's app_role immediately, so a promotion to `team-lead` — or, more
 * importantly for security, a removal from it — does not wait for their next
 * login.
 *
 * An event is used rather than a direct call because GithubTeamRoleService
 * already depends on GithubService; calling back the other way would be a
 * cycle. Same reasoning as REPOSITORY_DELETED_EVENT above.
 */
export const TEAM_MEMBERSHIP_CHANGED_EVENT = 'team.membership.changed';

export interface TeamMembershipChangedEvent {
  /** 'added' | 'removed' — GitHub's `action` on the membership event. */
  action: string;
  /** GitHub login of the affected user. */
  login: string;
  /** Slug of the team they were added to / removed from. */
  teamSlug: string;
  /** Installation id, used to mint a token for the follow-up team reads. */
  installationId: number;
}

export interface GithubWebhookTokenOps {
  createInstallationAccessToken(installationId: number): Promise<string>;
  fetchInstallationRepositories(token: string): Promise<string[]>;
}

export interface GithubWebhookProcessorDeps {
  getWebhookSecret(): string;
  installations: GithubInstallationsRepository | null;
  tokens: GithubWebhookTokenOps;
  emit(event: string, payload: unknown): void;
}

export class GithubWebhookProcessor {
  private readonly logger = new Logger(GithubWebhookProcessor.name);

  constructor(private readonly deps: GithubWebhookProcessorDeps) {}

  async handleWebhook(
    signature: string | undefined,
    eventName: string | undefined,
    deliveryId: string | undefined,
    rawBody: Buffer | undefined,
    payload: unknown,
  ): Promise<{ accepted: boolean; duplicate?: boolean }> {
    const appWebhookSecret = this.deps.getWebhookSecret();
    if (!appWebhookSecret) {
      throw new UnauthorizedException(
        'GitHub webhook secret is not configured.',
      );
    }
    if (!signature || !eventName || !deliveryId || !rawBody) {
      throw new UnauthorizedException(
        'Missing GitHub webhook headers or raw body.',
      );
    }

    const expected = `sha256=${createHmac('sha256', appWebhookSecret)
      .update(rawBody)
      .digest('hex')}`;
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException('Invalid GitHub webhook signature.');
    }

    if (!this.deps.installations) {
      return { accepted: true };
    }
    const claimed = await this.deps.installations.beginWebhookDelivery(
      deliveryId,
      eventName,
    );
    if (!claimed) {
      return { accepted: true, duplicate: true };
    }

    try {
      await this.processWebhookEvent(eventName, payload);
      await this.deps.installations.completeWebhookDelivery(deliveryId);
      return { accepted: true };
    } catch (error) {
      await this.deps.installations.releaseWebhookDelivery(deliveryId);
      throw error;
    }
  }

  private async processWebhookEvent(
    eventName: string,
    payload: unknown,
  ): Promise<void> {
    if (!payload || typeof payload !== 'object') return;
    const body = payload as Record<string, unknown>;

    // Handled before the `installation` guard below: a `repository` deleted
    // event carries everything it needs in `repository.full_name` and must
    // not depend on the installation payload shape (GitHub App webhooks
    // normally include `installation`, but there's no reason to make repo
    // deletion detection depend on it).
    if (eventName === 'repository' && body['action'] === 'deleted') {
      const repository = body['repository'];
      if (repository && typeof repository === 'object') {
        const fullName = (repository as Record<string, unknown>)['full_name'];
        if (typeof fullName === 'string' && fullName.trim().length > 0) {
          const event: RepositoryDeletedEvent = { repoFullName: fullName };
          this.deps.emit(REPOSITORY_DELETED_EVENT, event);
        } else {
          this.logger.warn(
            `Ignoring repository.deleted webhook with missing/invalid full_name`,
          );
        }
      } else {
        this.logger.warn(
          `Ignoring repository.deleted webhook with missing repository object`,
        );
      }
      return;
    }

    const installation = body['installation'];
    if (!installation || typeof installation !== 'object') return;
    const installationId = Number(
      (installation as Record<string, unknown>)['id'],
    );
    if (!Number.isInteger(installationId) || installationId < 1) return;

    // Org team membership changed — re-derive the affected user's app_role.
    // Emitted for BOTH 'added' and 'removed': a removal from `team-lead` must
    // revoke create rights promptly, which is the security-relevant direction.
    if (eventName === 'membership') {
      const action = body['action'];
      const member = body['member'];
      const team = body['team'];
      const login =
        member && typeof member === 'object'
          ? (member as Record<string, unknown>)['login']
          : undefined;
      const teamSlug =
        team && typeof team === 'object'
          ? (team as Record<string, unknown>)['slug']
          : undefined;

      if (
        typeof action === 'string' &&
        typeof login === 'string' &&
        login.trim().length > 0 &&
        typeof teamSlug === 'string'
      ) {
        const event: TeamMembershipChangedEvent = {
          action,
          login,
          teamSlug,
          installationId,
        };
        this.deps.emit(TEAM_MEMBERSHIP_CHANGED_EVENT, event);
      } else {
        this.logger.warn(
          'Ignoring membership webhook with missing action/member.login/team.slug',
        );
      }
      return;
    }

    if (eventName === 'installation') {
      const action = body['action'];
      if (action === 'deleted') {
        await this.deps.installations?.deleteInstallation(installationId);
      } else if (action === 'suspend') {
        await this.deps.installations?.setSuspended(installationId, true);
      } else if (action === 'unsuspend') {
        await this.deps.installations?.setSuspended(installationId, false);
      }
      return;
    }

    if (eventName === 'installation_repositories') {
      const token =
        await this.deps.tokens.createInstallationAccessToken(installationId);
      const repos = await this.deps.tokens.fetchInstallationRepositories(token);
      await this.deps.installations?.replaceRepos(installationId, repos);
    }
  }
}
