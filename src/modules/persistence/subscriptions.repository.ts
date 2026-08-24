import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';

import type {
  SubscriptionPlan,
  SubscriptionState,
} from '../../common/interfaces/session-user.interface';
import { DatabaseService } from '../../kernel/db/database.service';

interface PersistedSubscriptionRow {
  plan: SubscriptionPlan;
  status: 'inactive' | 'active' | 'canceled';
  provider: string;
  updated_at: string;
  plan_code: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  amount_php: number;
  interval_unit: 'month' | 'year';
}

@Injectable()
export class SubscriptionsRepository {
  private readonly logger = new Logger(SubscriptionsRepository.name);
  private planSeedPromise: Promise<void> | null = null;

  constructor(private readonly databaseService: DatabaseService) {}

  async getCurrentByUserId(userId: string): Promise<SubscriptionState | null> {
    await this.ensurePlanCatalog();

    const result = await this.databaseService.query<PersistedSubscriptionRow>(
      `
        SELECT
          plan,
          status,
          provider,
          updated_at,
          plan_code,
          current_period_start,
          current_period_end,
          cancel_at_period_end,
          amount_php,
          interval_unit
        FROM user_subscriptions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1;
      `,
      [userId],
    );

    const row = result.rows[0];
    return row ? this.toSubscriptionState(row) : null;
  }

  async ensureDefaultFreeSubscription(
    userId: string,
  ): Promise<SubscriptionState> {
    await this.ensurePlanCatalog();

    const current = await this.getCurrentByUserId(userId);
    if (current) {
      return current;
    }

    const result = await this.databaseService.query<PersistedSubscriptionRow>(
      `
        INSERT INTO user_subscriptions (
          user_id,
          plan,
          plan_code,
          status,
          provider,
          amount_php,
          interval_unit,
          current_period_start,
          current_period_end,
          cancel_at_period_end,
          metadata
        )
        VALUES ($1, 'free', 'free', 'active', 'supabase', 0, 'month', NULL, NULL, false, '{}'::jsonb)
        RETURNING
          plan,
          status,
          provider,
          updated_at,
          plan_code,
          current_period_start,
          current_period_end,
          cancel_at_period_end,
          amount_php,
          interval_unit;
      `,
      [userId],
    );

    const row = result.rows[0];
    if (!row) throw new Error('Subscription upsert returned no row');
    return this.toSubscriptionState(row);
  }

  async activateMonthlyPlan(
    userId: string,
    planCode: 'pro_monthly',
    amountPhp: number,
    provider: 'manual' | 'mock' | 'supabase' | 'paymongo' = 'manual',
  ): Promise<SubscriptionState> {
    await this.ensurePlanCatalog();

    return this.databaseService.withClient(async (client) => {
      await client.query('BEGIN');

      try {
        await client.query(
          `
            UPDATE user_subscriptions
            SET
              status = 'canceled',
              cancel_at_period_end = true,
              canceled_at = NOW(),
              updated_at = NOW()
            WHERE user_id = $1
              AND status = 'active';
          `,
          [userId],
        );

        const insert = await client.query<PersistedSubscriptionRow>(
          `
            INSERT INTO user_subscriptions (
              user_id,
              plan,
              plan_code,
              status,
              provider,
              amount_php,
              interval_unit,
              current_period_start,
              current_period_end,
              cancel_at_period_end,
              metadata
            )
            VALUES ($1, 'pro', $2, 'active', $3, $4, 'month', NOW(), NOW() + INTERVAL '1 month', false, '{}'::jsonb)
            RETURNING
              plan,
              status,
              provider,
              updated_at,
              plan_code,
              current_period_start,
              current_period_end,
              cancel_at_period_end,
              amount_php,
              interval_unit;
          `,
          [userId, planCode, provider, amountPhp],
        );

        await client.query('COMMIT');
        const insertedRow = insert.rows[0];
        if (!insertedRow) throw new Error('Activate plan returned no row');
        return this.toSubscriptionState(insertedRow);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async cancelCurrent(userId: string): Promise<SubscriptionState> {
    await this.ensurePlanCatalog();

    const result = await this.databaseService.query<PersistedSubscriptionRow>(
      `
        WITH latest AS (
          SELECT id
          FROM user_subscriptions
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        )
        UPDATE user_subscriptions current
        SET
          status = 'canceled',
          cancel_at_period_end = true,
          canceled_at = NOW(),
          updated_at = NOW()
        FROM latest
        WHERE current.id = latest.id
        RETURNING
          current.plan,
          current.status,
          current.provider,
          current.updated_at,
          current.plan_code,
          current.current_period_start,
          current.current_period_end,
          current.cancel_at_period_end,
          current.amount_php,
          current.interval_unit;
      `,
      [userId],
    );

    const row = result.rows[0];
    if (row) {
      return this.toSubscriptionState(row);
    }

    return this.ensureDefaultFreeSubscription(userId);
  }

  async ensurePlanCatalog(): Promise<void> {
    if (this.planSeedPromise !== null) {
      await this.planSeedPromise;
      return;
    }

    this.planSeedPromise = this.seedPlans();
    await this.planSeedPromise;
  }

  private async seedPlans(): Promise<void> {
    try {
      await this.databaseService.withClient(async (client) => {
        await client.query('BEGIN');
        try {
          await this.seedFreePlan(client);
          await this.seedProPlan(client);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    } catch (error) {
      this.logger.warn(`Plan seeding skipped: ${(error as Error).message}`);
    }
  }

  private async seedFreePlan(client: PoolClient): Promise<void> {
    await client.query(
      `
        INSERT INTO subscription_plans (code, name, amount_php, interval_unit)
        VALUES ('free', 'Free', 0, 'month')
        ON CONFLICT (code)
        DO UPDATE SET
          name = EXCLUDED.name,
          amount_php = EXCLUDED.amount_php,
          interval_unit = EXCLUDED.interval_unit,
          updated_at = NOW();
      `,
    );
  }

  private async seedProPlan(client: PoolClient): Promise<void> {
    await client.query(
      `
        INSERT INTO subscription_plans (code, name, amount_php, interval_unit)
        VALUES ('pro_monthly', 'Pro Monthly', 300, 'month')
        ON CONFLICT (code)
        DO UPDATE SET
          name = EXCLUDED.name,
          amount_php = EXCLUDED.amount_php,
          interval_unit = EXCLUDED.interval_unit,
          updated_at = NOW();
      `,
    );
  }

  private toSubscriptionState(
    row: PersistedSubscriptionRow,
  ): SubscriptionState {
    const provider: SubscriptionState['provider'] =
      row.provider === 'manual' ||
      row.provider === 'mock' ||
      row.provider === 'paymongo'
        ? row.provider
        : 'supabase';

    return {
      plan: row.plan,
      status: row.status,
      provider,
      updatedAt: row.updated_at,
      planCode: row.plan_code,
      currentPeriodStart: row.current_period_start,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: row.cancel_at_period_end,
      amountPhp: row.amount_php,
      interval: row.interval_unit,
    };
  }
}
