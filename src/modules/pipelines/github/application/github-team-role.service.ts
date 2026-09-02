import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  AppConfig,
  GithubTeamRoleSyncMode,
} from '#kernel/config/app.config';
import {
  PLATFORM_ADMIN_PORT,
  type PlatformAdminPort,
  type PlatformAppRole as AppRole,
} from '#kernel/ports/platform-admin.port';
import { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import {
  GITHUB_ORGANIZATION_PORT,
  type GithubOrganizationPort,
  type GithubTeamMembershipChangedEvent,
} from '#kernel/ports/github.port';
import { GithubInstallationsRepository } from '../infrastructure/github-installations.repository';

/** Sonar S6551-safe stringification of an unknown thrown value. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error) ?? 'unknown error';
}

/**
 * Outcome of a sync attempt. `unknown` is deliberately distinct from
 * `unchanged`: the first means GitHub could not be read (and nothing was
 * touched), the second means GitHub was read and already agreed.
 */
export type RoleSyncOutcome =
  | { status: 'disabled' }
  | { status: 'pinned'; role: AppRole }
  | { status: 'unknown' }
  | { status: 'unchanged'; role: AppRole }
  | { status: 'updated'; from: AppRole; to: AppRole };

/**
 * Derives identity.app_users.app_role from GitHub org team membership.
 *
 * Mapping (Alpha-Explora):
 *   org owner            → 'admin'   (login path only — needs the user token)
 *   member of `team-lead`   → 'lead'    (may create projects)
 *   member of `developers`  → 'member'  (assigned work only)
 *   in the org, neither team → 'member'
 *
 * Four safety rules, in priority order — every one of them exists to make a
 * GitHub outage or a permission gap harmless rather than destructive:
 *
 *  1. A user pinned to app_role_source = 'manual' is never touched.
 *  2. An UNREADABLE team check (null, not false) changes nothing. A transient
 *     403/5xx must never be read as "not a member" — that would demote the
 *     whole org on one bad response.
 *  3. An existing 'admin' is never auto-downgraded. Admin is org-owner and
 *     Console territory; the webhook path cannot even see ownership.
 *  4. Nothing happens at all unless GITHUB_TEAM_ROLE_SYNC opts in.
 */
@Injectable()
export class GithubTeamRoleService {
  private readonly logger = new Logger(GithubTeamRoleService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(GITHUB_ORGANIZATION_PORT)
    private readonly githubService: GithubOrganizationPort,
    @Inject(PLATFORM_ADMIN_PORT)
    private readonly roleAccess: PlatformAdminPort,
    private readonly auditEventsService: AuditEventPublisher,
    private readonly installationsRepository: GithubInstallationsRepository,
  ) {
    // Fire-and-forget, matching ProjectsService's repository.deleted listener:
    // handleWebhook() has already ack'd the delivery to GitHub by the time this
    // runs, so a failure is logged rather than thrown. The periodic worker
    // (Phase 4b) is the backstop for anything dropped here.
    this.githubService.onTeamMembershipChanged(
      (event: GithubTeamMembershipChangedEvent) => {
        this.handleMembershipEvent(event).catch((error: unknown) => {
          this.logger.warn(
            `Failed to process membership webhook for ${event.login}: ${describeError(error)}`,
          );
        });
      },
    );
  }

  /**
   * Only the two configured role teams matter. A membership change on any
   * other org team (including the per-repository `{repo}-developers` access
   * teams this product creates itself) must not touch app_role — otherwise
   * granting someone repo access would silently re-role them.
   */
  private async handleMembershipEvent(
    event: GithubTeamMembershipChangedEvent,
  ): Promise<void> {
    if (this.mode !== 'enforce') return;

    const { leadTeamSlug, developerTeamSlug } = this.config.github;
    const slug = event.teamSlug.toLowerCase();
    if (
      slug !== leadTeamSlug.toLowerCase() &&
      slug !== developerTeamSlug.toLowerCase()
    ) {
      return;
    }

    await this.syncFromMembershipEvent({
      login: event.login,
      installationId: event.installationId,
    });
  }

  get mode(): GithubTeamRoleSyncMode {
    return this.config.github.teamRoleSync;
  }

  get enabled(): boolean {
    return this.mode !== 'off';
  }

  /**
   * Reads both team memberships and returns the role they imply.
   *
   * Returns null when the answer is genuinely unknown — either team check came
   * back unreadable AND no positive membership was established. A positive
   * `team-lead` hit short-circuits, so a broken `developers` read can never
   * block a promotion.
   */
  async resolveRoleFromTeams(
    login: string,
    token: string,
  ): Promise<AppRole | null> {
    const { leadTeamSlug, developerTeamSlug } = this.config.github;

    const inLeadTeam = await this.githubService.getTeamMembership(
      leadTeamSlug,
      login,
      token,
    );
    if (inLeadTeam === true) return 'lead';

    const inDeveloperTeam = await this.githubService.getTeamMembership(
      developerTeamSlug,
      login,
      token,
    );
    if (inDeveloperTeam === true) return 'member';

    // Both answered "no" → the user is in the org but on neither role team.
    // 'member' is the correct floor: they can sign in and see what they are
    // assigned, but cannot create.
    if (inLeadTeam === false && inDeveloperTeam === false) return 'member';

    // At least one check was unreadable and neither was a positive hit.
    return null;
  }

  /**
   * Applies the derived role to a user, honouring every safety rule above.
   * Safe to call on any path; it no-ops unless sync is enabled.
   */
  async syncRoleForUser(input: {
    userId: string;
    login: string;
    token: string;
    /** Set at login when the user owns the enforced org — an upgrade only. */
    isOrgOwner?: boolean;
    /** Free-text provenance for the audit trail, e.g. 'login' or 'webhook'. */
    trigger: string;
  }): Promise<RoleSyncOutcome> {
    if (this.mode !== 'enforce') return { status: 'disabled' };

    const { role: currentRole, source } =
      await this.roleAccess.findAppRoleWithSource(input.userId);

    // Rule 1 — a deliberate Console decision wins until explicitly reset.
    if (source === 'manual') return { status: 'pinned', role: currentRole };

    const derived = input.isOrgOwner
      ? 'admin'
      : await this.resolveRoleFromTeams(input.login, input.token);

    // Rule 2 — unreadable means untouched.
    if (derived === null) {
      this.logger.warn(
        `Team role sync for ${input.login} (${input.trigger}): GitHub unreadable, leaving app_role='${currentRole}' unchanged.`,
      );
      return { status: 'unknown' };
    }

    // Rule 3 — never auto-downgrade an admin.
    if (currentRole === 'admin' && derived !== 'admin') {
      return { status: 'unchanged', role: currentRole };
    }

    if (derived === currentRole) return { status: 'unchanged', role: derived };

    await this.roleAccess.setAppRole(input.userId, derived, 'github_team');

    // Automatic role changes MUST be auditable — without this, a user's
    // capabilities can change with no record of why, which is undebuggable.
    await this.recordRoleChange({
      userId: input.userId,
      login: input.login,
      from: currentRole,
      to: derived,
      trigger: input.trigger,
    });

    this.logger.log(
      `Team role sync for ${input.login} (${input.trigger}): app_role ${currentRole} → ${derived}.`,
    );
    return { status: 'updated', from: currentRole, to: derived };
  }

  /**
   * Role to seed on a brand-new account. Used under both 'seed' and 'enforce';
   * returns null when sync is off or GitHub could not be read, letting the
   * caller fall back to the legacy org-ownership seed.
   */
  async resolveSeedRole(
    login: string,
    token: string,
    isOrgOwner: boolean,
  ): Promise<AppRole | null> {
    if (!this.enabled) return null;
    if (isOrgOwner) return 'admin';

    const fromUserToken = await this.resolveRoleFromTeams(login, token);
    if (fromUserToken !== null) return fromUserToken;

    // The user's OAuth token could not answer. Ask again as the App before
    // giving up, because this path is NOT symmetric with the returning-login
    // path and an unreadable answer here is not harmless:
    //
    //   - Returning login (syncRoleForUser) applies Rule 2 — unreadable means
    //     untouched, so the user keeps the role they already had.
    //   - FIRST login has no role to keep. The caller in auth.service.ts turns
    //     our null into `isOrgOwner ? 'admin' : 'member'` and writes it with
    //     app_role_source = 'github_team' — a guess, recorded as though GitHub
    //     had confirmed it. A genuine `team-lead` then signs in as a Member,
    //     sees no create-workspace affordance, and has no way to fix it from
    //     inside the app.
    //
    // The installation token is the stronger reader: it carries the App's org
    // Members:Read grant, so it works where a user token is missing read:org
    // or the org has OAuth App access restrictions turned on — the two most
    // common causes of the null above, and both of them permanent rather than
    // transient. This is the same authority the reconcile sweep already uses;
    // borrowing it here just moves the correction from "up to one sweep
    // interval later" to "before the row is ever written".
    return this.resolveRoleFromTeamsAsApp(login);
  }

  /**
   * Derives the role using an App installation token instead of a user token.
   *
   * Returns null on every failure — no installation for the org, no token, or
   * teams still unreadable. Callers must treat null as "unknown", never as
   * "not a member": this runs precisely when we already know one reader is
   * blind, so a second blind answer must not be upgraded into a fact.
   */
  private async resolveRoleFromTeamsAsApp(
    login: string,
  ): Promise<AppRole | null> {
    const org = this.githubService.getEnforcedOrg();
    if (!org) return null;

    try {
      const installationId =
        await this.installationsRepository.findInstallationIdByAccountLogin(
          org,
        );
      if (installationId === null) {
        this.logger.warn(
          `Seed role for ${login}: no GitHub App installation for org ${org}, so the team check stays unresolved.`,
        );
        return null;
      }

      const token =
        await this.githubService.createInstallationAccessToken(installationId);
      return await this.resolveRoleFromTeams(login, token);
    } catch (error) {
      this.logger.warn(
        `Seed role for ${login}: installation-token team check failed: ${describeError(error)}`,
      );
      return null;
    }
  }

  /**
   * Webhook entry point. GitHub's `membership` event carries the org
   * installation id, so we mint an installation token rather than depending on
   * the affected user having their own installation — a developer being added
   * to a team usually has none.
   */
  async syncFromMembershipEvent(input: {
    login: string;
    installationId: number;
  }): Promise<RoleSyncOutcome> {
    if (this.mode !== 'enforce') return { status: 'disabled' };

    const userId = await this.roleAccess.findUserIdByGithubLogin(input.login);
    if (!userId) {
      // Org member who has never signed into AlphaCI — nothing to update. They
      // pick up the right role from the seed on their first login.
      return { status: 'unknown' };
    }

    let token: string;
    try {
      token = await this.githubService.createInstallationAccessToken(
        input.installationId,
      );
    } catch (error) {
      this.logger.warn(
        `Membership webhook for ${input.login}: could not mint an installation token: ${describeError(error)}`,
      );
      return { status: 'unknown' };
    }

    return this.syncRoleForUser({
      userId,
      login: input.login,
      token,
      trigger: 'webhook:membership',
    });
  }

  /**
   * Periodic sweep that reconciles every GitHub-synced user against the two
   * team rosters. The safety net for webhook deliveries that were missed,
   * dropped, or arrived while the service was down.
   *
   * Reads the two rosters ONCE (2 API calls) and reconciles in memory, rather
   * than issuing a membership check per user — with a few dozen users that is
   * the difference between 2 requests and 100.
   *
   * Bails out entirely if either roster comes back empty. An empty roster is
   * indistinguishable from an unreadable one at this layer (listTeamMembers
   * degrades to [] on failure), and treating "unreadable" as "nobody is in
   * team-lead" would demote every lead in the org in one pass. Refusing to act
   * on an ambiguous read is the whole point.
   */
  async reconcileAll(): Promise<{
    status: 'disabled' | 'unreadable' | 'completed';
    checked?: number;
    updated?: number;
  }> {
    if (this.mode !== 'enforce') return { status: 'disabled' };

    const org = this.githubService.getEnforcedOrg();
    const installationId =
      await this.installationsRepository.findInstallationIdByAccountLogin(org);
    if (!installationId) {
      this.logger.warn(
        `Role reconciliation skipped: no GitHub App installation found for org ${org}.`,
      );
      return { status: 'unreadable' };
    }

    const { leadTeamSlug, developerTeamSlug } = this.config.github;
    let leadMembers: string[];
    let developerMembers: string[];
    try {
      const token =
        await this.githubService.createInstallationAccessToken(installationId);
      [leadMembers, developerMembers] = await Promise.all([
        this.githubService.listTeamMembersWithToken(leadTeamSlug, token),
        this.githubService.listTeamMembersWithToken(developerTeamSlug, token),
      ]);
    } catch (error) {
      this.logger.warn(
        `Role reconciliation could not read team rosters: ${describeError(error)}`,
      );
      return { status: 'unreadable' };
    }

    if (leadMembers.length === 0 && developerMembers.length === 0) {
      this.logger.warn(
        'Role reconciliation skipped: both team rosters came back empty, which is indistinguishable from an unreadable response.',
      );
      return { status: 'unreadable' };
    }

    const leads = new Set(leadMembers.map((login) => login.toLowerCase()));
    const users = await this.roleAccess.listGithubTeamSyncedUsers();

    let updated = 0;
    for (const user of users) {
      // Rule 3 still applies — admins are owner/Console territory.
      if (user.appRole === 'admin') continue;

      const derived: AppRole = leads.has(user.login.toLowerCase())
        ? 'lead'
        : 'member';
      if (derived === user.appRole) continue;

      await this.roleAccess.setAppRole(user.id, derived, 'github_team');
      await this.recordRoleChange({
        userId: user.id,
        login: user.login,
        from: user.appRole,
        to: derived,
        trigger: 'reconcile',
      });
      updated += 1;
    }

    if (updated > 0) {
      this.logger.log(
        `Role reconciliation updated ${String(updated)} of ${String(users.length)} synced users.`,
      );
    }
    return { status: 'completed', checked: users.length, updated };
  }

  private async recordRoleChange(input: {
    userId: string;
    login: string;
    from: AppRole;
    to: AppRole;
    trigger: string;
  }): Promise<void> {
    // recordProjectEvent is the swallow-on-failure wrapper (its name is
    // historical — it takes any audit event). An audit write must never block
    // the role change itself.
    await this.auditEventsService.recordProjectEvent({
      actorUserId: null,
      eventCode: 'user.app_role.synced',
      message: `app_role ${input.from} → ${input.to} from GitHub teams (${input.trigger})`,
      metadata: {
        targetUserId: input.userId,
        login: input.login,
        from: input.from,
        to: input.to,
        trigger: input.trigger,
        source: 'github_team',
      },
    });
  }

  private get config(): AppConfig {
    return this.configService.getOrThrow<AppConfig>('app');
  }
}
