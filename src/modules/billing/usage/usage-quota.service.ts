import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import { DatabaseService } from '#kernel/db/database.service';
import {
  DEPLOYMENT_USAGE_FACTS,
  type DeploymentUsageProviderId,
} from '#modules/runtime/index.js';
import type { UsageLimitCode, UsageMeResponse } from './usage.types';

const DEFAULT_LIMITS: Record<'free' | 'pro', Record<UsageLimitCode, number>> = {
  free: {
    projects: 3,
    managed_render_services: 1,
    managed_vercel_projects: 1,
    deployment_targets: 5,
    env_keys: 25,
    workflow_prs: 5,
  },
  pro: {
    projects: 50,
    managed_render_services: 10,
    managed_vercel_projects: 10,
    deployment_targets: 100,
    env_keys: 500,
    workflow_prs: 100,
  },
};

@Injectable()
export class UsageQuotaService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
  ) {}

  async getUsage(userId: string): Promise<UsageMeResponse> {
    const internal = await this.isInternalUser(userId);
    return this.buildUsage(userId, internal);
  }

  private async buildUsage(
    userId: string,
    internal: boolean,
  ): Promise<UsageMeResponse> {
    // Internal users share the same database as the paid platform but are never
    // quota-limited, so quotas read as disabled and nothing prompts an upgrade.
    const enabled = this.enabled() && !internal;
    const plan = await this.resolvePlan(userId);
    const counts = await this.loadCounts(userId);
    const limits = DEFAULT_LIMITS[plan];

    return {
      enabled,
      plan,
      items: (Object.keys(limits) as UsageLimitCode[]).map((code) => ({
        code,
        current: counts[code] ?? 0,
        limit: limits[code],
        upgradeRequired: !internal && (counts[code] ?? 0) >= limits[code],
      })),
    };
  }

  async assertWithinLimit(
    userId: string,
    limitCode: UsageLimitCode,
    increment = 1,
  ): Promise<void> {
    if (!this.enabled()) {
      return;
    }

    // Internal users (company GitHub org members, is_internal=true) are exempt
    // from usage quotas, mirroring the entitlement bypass in SubscriptionService.
    // The paid platform (is_internal=false) keeps every limit despite sharing
    // this database.
    const internal = await this.isInternalUser(userId);
    if (internal) {
      return;
    }

    const usage = await this.buildUsage(userId, internal);
    const item = usage.items.find((candidate) => candidate.code === limitCode);
    if (!item) {
      return;
    }

    if (item.current + increment > item.limit) {
      throw new BadRequestException({
        message: 'Usage quota exceeded',
        limitCode,
        current: item.current,
        limit: item.limit,
        upgradeRequired: usage.plan === 'free',
      });
    }
  }

  /**
   * Platform-wide capacity guard for managed provisioning.
   *
   * Managed ('flowci_managed') targets all share a single Render/Vercel account,
   * so per-user quotas cannot protect that shared account from the aggregate of
   * every user. This counts managed targets across ALL users for the provider
   * and refuses new ones once the configured fleet cap is reached, pointing the
   * user at BYO. A cap of 0 (default) means unlimited / disabled.
   *
   * Note: this is a soft cap — the count-then-insert is not atomic, so a burst
   * of concurrent creates may overshoot by a few. That is acceptable for a
   * coarse safety ceiling; the per-user quota remains the hard per-tenant limit.
   */
  async assertManagedFleetCapacity(
    provider: DeploymentUsageProviderId,
  ): Promise<void> {
    if (!this.databaseService.isEnabled()) {
      return;
    }

    const config = this.configService.getOrThrow<AppConfig>('app');
    const fact = DEPLOYMENT_USAGE_FACTS.find(
      (candidate) => candidate.providerId === provider,
    );
    if (!fact) {
      return;
    }
    const cap =
      config.envProvisioning.flowciManaged[fact.fleetCapConfigKey] ?? 0;

    if (!Number.isFinite(cap) || cap <= 0) {
      return;
    }

    const result = await this.databaseService.query<{
      count: string | number;
    }>(
      `
        SELECT COUNT(*) AS count
        FROM env_provisioning.project_deployment_targets
        WHERE ownership_mode = 'flowci_managed' AND provider = $1;
      `,
      [provider],
    );
    const current = this.toNumber(result.rows[0]?.count);

    if (current + 1 > cap) {
      throw new ServiceUnavailableException({
        message:
          `Managed ${fact.providerLabel} provisioning is at capacity. ` +
          `Connect your own ${fact.providerLabel} account (BYO) to continue, or try again later.`,
        provider,
        current,
        limit: cap,
        managedFleetExhausted: true,
      });
    }
  }

  private enabled(): boolean {
    const config = this.configService.getOrThrow<AppConfig>('app');
    return config.usageQuotas?.enabled ?? false;
  }

  /**
   * True when the user is an internal company user (stamped is_internal=true on
   * the internal deployment via GITHUB_INTERNAL_ORG membership). Internal users
   * are exempt from usage quotas even though they live in the same database as
   * paid-platform users; this is the single seam that separates the two
   * audiences, consistent with SubscriptionService.
   */
  private async isInternalUser(userId: string): Promise<boolean> {
    const result = await this.databaseService.query<{
      is_internal: boolean | null;
    }>(`SELECT is_internal FROM identity.app_users WHERE id = $1 LIMIT 1;`, [
      userId,
    ]);
    return result.rows[0]?.is_internal === true;
  }

  private async resolvePlan(userId: string): Promise<'free' | 'pro'> {
    const result = await this.databaseService.query<{ plan_code: string }>(
      `
        SELECT plan_code
        FROM billing.user_subscriptions
        WHERE user_id = $1
          AND status = 'active'
        ORDER BY updated_at DESC NULLS LAST, created_at DESC
        LIMIT 1;
      `,
      [userId],
    );
    const planCode = result.rows[0]?.plan_code;
    return planCode === 'pro' || planCode === 'pro_monthly' ? 'pro' : 'free';
  }

  private async loadCounts(
    userId: string,
  ): Promise<Record<UsageLimitCode, number>> {
    const result = await this.databaseService.query<{
      projects: string | number;
      managed_render_services?: string | number;
      managed_vercel_projects?: string | number;
      deployment_targets: string | number;
      env_keys: string | number;
      workflow_prs: string | number;
      managed_provider?: string | null;
      managed_count?: string | number | null;
    }>(
      `
        WITH managed_counts AS (
          SELECT t.provider, COUNT(*) AS count
          FROM env_provisioning.project_deployment_targets t
          JOIN projects.provisioned_projects p ON p.id = t.project_id
          WHERE p.user_id = $1 AND t.ownership_mode = 'flowci_managed'
          GROUP BY t.provider
        )
        SELECT
          (SELECT COUNT(*) FROM projects.provisioned_projects WHERE user_id = $1 AND is_example = false) AS projects,
          (
            SELECT COUNT(*)
            FROM env_provisioning.project_deployment_targets t
            JOIN projects.provisioned_projects p ON p.id = t.project_id
            WHERE p.user_id = $1
          ) AS deployment_targets,
          (
            SELECT COUNT(*)
            FROM env_provisioning.project_env_var_metadata m
            JOIN projects.provisioned_projects p ON p.id = m.project_id
            WHERE p.user_id = $1 AND m.removed_at IS NULL
          ) AS env_keys,
          (
            SELECT COUNT(*)
            FROM projects.project_workflow_update_requests r
            JOIN projects.provisioned_projects p ON p.id = r.project_id
            WHERE p.user_id = $1
          ) AS workflow_prs,
          managed_counts.provider AS managed_provider,
          managed_counts.count AS managed_count
        FROM (SELECT 1) AS base
        LEFT JOIN managed_counts ON TRUE;
      `,
      [userId],
    );
    const row = result.rows[0];
    const counts: Record<UsageLimitCode, number> = {
      projects: this.toNumber(row?.projects),
      managed_render_services: this.toNumber(row?.managed_render_services),
      managed_vercel_projects: this.toNumber(row?.managed_vercel_projects),
      deployment_targets: this.toNumber(row?.deployment_targets),
      env_keys: this.toNumber(row?.env_keys),
      workflow_prs: this.toNumber(row?.workflow_prs),
    };

    for (const fact of DEPLOYMENT_USAGE_FACTS) {
      const providerRow = result.rows.find(
        (candidate) => candidate.managed_provider === fact.providerId,
      );
      if (providerRow?.managed_provider) {
        counts[fact.quotaCode] = this.toNumber(providerRow.managed_count);
      }
    }

    return counts;
  }

  private toNumber(value: string | number | null | undefined): number {
    return Number(value ?? 0);
  }
}
