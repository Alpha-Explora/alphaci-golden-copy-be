import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  DEPLOYMENT_CAPABILITY_RESOLVER,
  type CapabilityResolverPort,
} from '#kernel/composition/capability-resolver.port.js';
import type { AppConfig } from '#kernel/config/app.config';
import { DatabaseService } from '#kernel/db/database.service';
import type {
  ManagedFleetCapacityFact,
  ManagedQuotaDefinition,
  UsageQuotaPort,
} from '#kernel/ports/usage-quota.port';
import {
  TENANT_CONTEXT,
  type TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';
import type { UsageLimitCode, UsageMeResponse } from './usage.types';

const DEFAULT_LIMITS: Record<'free' | 'pro', Record<string, number>> = {
  free: {
    projects: 3,
    deployment_targets: 5,
    env_keys: 25,
    workflow_prs: 5,
  },
  pro: {
    projects: 50,
    deployment_targets: 100,
    env_keys: 500,
    workflow_prs: 100,
  },
};

@Injectable()
export class UsageQuotaService implements UsageQuotaPort {
  private readonly managedQuotaDefinitions = new Map<
    string,
    ManagedQuotaDefinition
  >();

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
    @Optional()
    @Inject(DEPLOYMENT_CAPABILITY_RESOLVER)
    private readonly capabilityResolver?: CapabilityResolverPort,
    @Optional()
    @Inject(TENANT_CONTEXT)
    private readonly tenantContext?: TenantContextPort,
  ) {}

  /**
   * Called by runtime composition after provider policies are constructed.
   * Keeping registration one-way means billing never imports runtime or a
   * provider implementation just to render the usage screen.
   */
  registerManagedQuota(definition: ManagedQuotaDefinition): void {
    const existing = this.managedQuotaDefinitions.get(definition.providerId);
    if (existing && existing.quotaCode !== definition.quotaCode) {
      throw new Error(
        `Managed quota already registered for provider '${definition.providerId}'`,
      );
    }
    this.managedQuotaDefinitions.set(definition.providerId, definition);
  }

  async getUsage(userId: string): Promise<UsageMeResponse> {
    const tenantId = this.requireTenantId();
    const internal = await this.isInternalUser(userId);
    return this.buildUsage(userId, internal, tenantId);
  }

  private async buildUsage(
    userId: string,
    internal: boolean,
    tenantId: string,
  ): Promise<UsageMeResponse> {
    // Internal users share the same database as the paid platform but are never
    // quota-limited, so quotas read as disabled and nothing prompts an upgrade.
    const enabled = this.enabled() && !internal;
    const plan = await this.resolvePlan(userId);
    const counts = await this.loadCounts(userId, tenantId);
    const limits = this.limitsForPlan(plan);

    return {
      enabled,
      plan,
      items: (Object.keys(limits) as UsageLimitCode[]).map((code) => ({
        code,
        current: counts[code] ?? 0,
        limit: limits[code] ?? 0,
        upgradeRequired:
          !internal && (counts[code] ?? 0) >= (limits[code] ?? 0),
      })),
    };
  }

  async assertWithinLimit(
    userId: string,
    limitCode: string,
    increment = 1,
  ): Promise<void> {
    const tenantId = this.requireTenantId();
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

    const usage = await this.buildUsage(userId, internal, tenantId);
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
   * Explicit deployment-global capacity guard for managed provisioning.
   *
   * Managed ('flowci_managed') targets all share a single Render/Vercel account,
   * so per-user quotas cannot protect that shared account from the aggregate of
   * every user. This counts managed targets across ALL users and tenants for the provider
   * and refuses new ones once the configured fleet cap is reached, pointing the
   * user at BYO. A cap of 0 (default) means unlimited / disabled.
   *
   * Note: this is a soft cap — the count-then-insert is not atomic, so a burst
   * of concurrent creates may overshoot by a few. That is acceptable for a
   * coarse safety ceiling; the per-user quota remains the hard per-tenant limit.
   * This is the only deployment-global operation in this service and it
   * intentionally does not require request tenant context because workers may
   * call it during reconciliation.
   */
  async assertDeploymentGlobalManagedFleetCapacity(
    fact: ManagedFleetCapacityFact,
  ): Promise<void> {
    if (!this.databaseService.isEnabled()) {
      return;
    }

    const config = this.configService.getOrThrow<AppConfig>('app');
    const managedConfig = config.envProvisioning.flowciManaged;
    const configuredCap =
      managedConfig[fact.fleetCapConfigKey as keyof typeof managedConfig];
    const cap =
      typeof configuredCap === 'number'
        ? configuredCap
        : Number(configuredCap ?? 0);

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
      [fact.providerId],
    );
    const current = this.toNumber(result.rows[0]?.count);

    if (current + 1 > cap) {
      throw new ServiceUnavailableException({
        message:
          `Managed ${fact.providerLabel} provisioning is at capacity. ` +
          `Connect your own ${fact.providerLabel} account (BYO) to continue, or try again later.`,
        provider: fact.providerId,
        current,
        limit: cap,
        managedFleetExhausted: true,
      });
    }
  }

  /**
   * Compatibility name for existing callers. The delegated operation is still
   * explicitly deployment-global; request-facing quota methods fail closed
   * without validated tenant context.
   */
  async assertManagedFleetCapacity(
    fact: ManagedFleetCapacityFact,
  ): Promise<void> {
    return this.assertDeploymentGlobalManagedFleetCapacity(fact);
  }

  private enabled(): boolean {
    return (
      this.capabilityResolver?.deployment().has('billing.usage-quotas') ?? false
    );
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

  /**
   * Billing subscriptions are account-level entitlements keyed by user_id in
   * the current schema. That is intentionally account-global, not
   * deployment-global: the caller still must establish tenant context and all
   * resource counters remain tenant-scoped in loadCounts.
   */
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
    tenantId: string,
  ): Promise<Record<string, number>> {
    const result = await this.databaseService.query<{
      projects: string | number;
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
          WHERE p.user_id = $1
            AND p.tenant_id = $2::uuid
            AND t.ownership_mode = 'flowci_managed'
          GROUP BY t.provider
        )
        SELECT
          (SELECT COUNT(*)
           FROM projects.provisioned_projects
           WHERE user_id = $1
             AND tenant_id = $2::uuid
             AND is_example = false) AS projects,
          (
            SELECT COUNT(*)
            FROM env_provisioning.project_deployment_targets t
            JOIN projects.provisioned_projects p ON p.id = t.project_id
            WHERE p.user_id = $1 AND p.tenant_id = $2::uuid
          ) AS deployment_targets,
          (
            SELECT COUNT(*)
            FROM env_provisioning.project_env_var_metadata m
            JOIN projects.provisioned_projects p ON p.id = m.project_id
            WHERE p.user_id = $1
              AND p.tenant_id = $2::uuid
              AND m.removed_at IS NULL
          ) AS env_keys,
          (
            SELECT COUNT(*)
            FROM projects.project_workflow_update_requests r
            JOIN projects.provisioned_projects p ON p.id = r.project_id
            WHERE p.user_id = $1 AND p.tenant_id = $2::uuid
          ) AS workflow_prs,
          managed_counts.provider AS managed_provider,
          managed_counts.count AS managed_count
        FROM (SELECT 1) AS base
        LEFT JOIN managed_counts ON TRUE;
      `,
      [userId, tenantId],
    );
    const row = result.rows[0];
    const counts: Record<string, number> = {
      projects: this.toNumber(row?.projects),
      deployment_targets: this.toNumber(row?.deployment_targets),
      env_keys: this.toNumber(row?.env_keys),
      workflow_prs: this.toNumber(row?.workflow_prs),
    };

    for (const fact of this.managedQuotaDefinitions.values()) {
      const providerRow = result.rows.find(
        (candidate) => candidate.managed_provider === fact.providerId,
      );
      if (providerRow?.managed_provider) {
        counts[fact.quotaCode] = this.toNumber(providerRow.managed_count);
      }
    }

    return counts;
  }

  private limitsForPlan(plan: 'free' | 'pro'): Record<string, number> {
    const base = DEFAULT_LIMITS[plan];
    const limits: Record<string, number> = {
      projects: base.projects ?? 0,
    };
    for (const definition of this.managedQuotaDefinitions.values()) {
      limits[definition.quotaCode] =
        plan === 'free' ? definition.freeLimit : definition.proLimit;
    }
    for (const code of [
      'deployment_targets',
      'env_keys',
      'workflow_prs',
    ] as const) {
      limits[code] = base[code] ?? 0;
    }
    return limits;
  }

  private toNumber(value: string | number | null | undefined): number {
    return Number(value ?? 0);
  }

  private requireTenantId(): string {
    if (!this.tenantContext) {
      throw new TenantContextRequiredError();
    }
    return this.tenantContext.require().tenantId;
  }
}
