import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SUBSCRIPTION_ACCESS } from '#kernel/auth/subscription-access.port';
import { DatabaseModule } from '#kernel/db/database.module';
import { EventsModule } from '#kernel/events/events.module';
import { SubscriptionController } from './subscription.controller';
import { SubscriptionService } from './subscription.service';
import { SubscriptionsRepository } from './infra/subscriptions.repository';
import { SUBSCRIPTION_BOOTSTRAP } from './subscription.contracts';

@Module({
  imports: [DatabaseModule, EventsModule],
  controllers: [SubscriptionController],
  providers: [
    SubscriptionsRepository,
    {
      provide: SUBSCRIPTION_BOOTSTRAP,
      useExisting: SubscriptionsRepository,
    },
    SubscriptionService,
    {
      provide: SUBSCRIPTION_ACCESS,
      useExisting: SubscriptionService,
    },
    SessionAuthGuard,
  ],
  exports: [SubscriptionService, SUBSCRIPTION_BOOTSTRAP, SUBSCRIPTION_ACCESS],
})
export class SubscriptionModule {}
