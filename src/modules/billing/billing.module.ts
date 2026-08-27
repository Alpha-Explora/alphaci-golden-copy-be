import { Module } from '@nestjs/common';

import { SubscriptionModule } from './subscription/subscription.module';
import { UsageModule } from './usage/usage.module';

/** Bounded-context composition root for entitlements and usage. */
@Module({
  imports: [SubscriptionModule, UsageModule],
  exports: [SubscriptionModule, UsageModule],
})
export class BillingModule {}
