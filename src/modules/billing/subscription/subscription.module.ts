import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '#kernel/auth/session-auth.guard';
import { SUBSCRIPTION_ACCESS } from '#kernel/auth/subscription-access.port';
import { DatabaseModule } from '#kernel/db/database.module';
import { EventsModule } from '#kernel/events/events.module';
import { SUBSCRIPTION_BOOTSTRAP } from '#kernel/ports/subscription-bootstrap.port';
import { SubscriptionController } from './api/subscription.controller';
import { SubscriptionService } from './application/subscription.service';
import { SubscriptionsRepository } from './infrastructure/subscriptions.repository';

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
